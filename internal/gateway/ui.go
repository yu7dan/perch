package gateway

/* 网关页直接使用 magpie 自己的界面（2026-10-18 用户定的方向）。
 *
 * 为什么不"把 magpie 的前端源码抄进 assets/"：那套前端（app.js 1.2MB、
 * routing.js、plugins.js、i18n.js…）每条数据都走 /api/*，背后是整台控制面。
 * 抄前端等于重写后端。这里把**正在运行的** `magpie web` 反代到 Perch 旁边，
 * 界面永远和已安装的 magpie 一致。
 *
 * 为什么不用 Wails 的 asset handler 直接反代 /api/*：实测（2026-10-18）
 * WebView2 交给 asset handler 的请求**没有请求体** —— 页面里一次
 * `fetch("/api/providers/arrange", {method:"POST", body:...})` 到达 handler 时
 * Content-Length=0，magpie 解码出 EOF，排序保存失败。Wails 的
 * request_windows.go 会读 GetContent()，但这一版（beta.24）拿不到。
 * 所以反代跑在**一个独立的 127.0.0.1 监听**上：iframe 先访问 Wails 同源的
 * /gwui/ → 302 到这个监听 → 页面与它的 /api/* 全部走真实 HTTP，POST 正常。
 *
 * 只搬网关自己的部分（用户 2026-10-18 的要求）：magpie 这个页面是它整个应用
 * 的界面，左栏里还有 Agents / Sessions / Library / Settings —— 这些会和 Perch
 * 自己的总览、Agent 重复。所以内嵌页只留网关的导航（供应商 / 路由 / 网关 /
 * 用量 / 插件），并且导航按 magpie 自己的顶部标签布局摆（见 uiEmbed）。
 *
 * 安全：
 *   · 监听只绑 127.0.0.1，端口在 3459 起的固定段里挑；
 *   · 每次运行生成一枚随机 token，第一次带 ?t= 换成 HttpOnly cookie，之后
 *     所有请求都校验它 —— 本机别的进程扫到端口也进不来；
 *   · magpie 的 key 只在 Go 里，由反代逐请求注入 Cookie，不进浏览器地址/日志。
 */

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const uiCookie = "perch_gw"

/* 优先固定端口：origin 稳定，magpie 页面自己的 localStorage（侧栏/顶栏
 * 选择、字号、上次的页）才能在 Perch 重启后留下来。端口被占就从 3459
 * 往后试，全占了再用系统分配（这一次运行不记忆偏好）。 */
const uiFirstPort = 3459
const uiPortTries = 8

type uiState struct {
	mu    sync.Mutex
	port  int
	token string
	ln    net.Listener
	srv   *http.Server
}

func uiRand(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("perch%032x", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

// StartUI 起本地反代。优先固定端口段（origin 稳定），全被占才让系统分配。
// 失败只记日志：网关页会显示错误，Perch 其余部分不受影响。
func (g *Gateway) StartUI() {
	g.uiMu.Lock()
	defer g.uiMu.Unlock()
	if g.ui != nil && g.ui.srv != nil {
		return
	}
	var ln net.Listener
	var err error
	for p := uiFirstPort; p < uiFirstPort+uiPortTries; p++ {
		if ln, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p)); err == nil {
			break
		}
	}
	if ln == nil {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
	}
	if err != nil {
		log.Printf("[gwui] 本地反代启动失败：%v", err)
		return
	}
	token := uiRand(16)
	srv := &http.Server{Handler: uiWithAuth(token, &uiProxy{g: g})}
	g.ui = &uiState{ln: ln, srv: srv, token: token}
	if a, ok := ln.Addr().(*net.TCPAddr); ok {
		g.ui.port = a.Port
	}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("[gwui] 本地反代停止：%v", err)
		}
	}()
	log.Printf("[gwui] 本地反代 127.0.0.1:%d（只监听本机）", g.ui.port)
}

// frameURL 给 iframe 用。带 token 的第一次请求换 cookie，之后地址里没有它。
func (g *Gateway) frameURL(path, query string) string {
	g.uiMu.Lock()
	port, token := 0, ""
	if g.ui != nil {
		port, token = g.ui.port, g.ui.token
	}
	g.uiMu.Unlock()
	if port == 0 || token == "" {
		return ""
	}
	if query != "" {
		query += "&"
	}
	// 主机名用 gui.wails.localhost（解析到回环），不是 127.0.0.1：
	// 顶层页面是 http://wails.localhost，两者**同站**，iframe 里的
	// Set-Cookie 才不会被 Chromium 当第三方 cookie 丢掉（实测 127.0.0.1
	// 会 401：token cookie 存不进去）。监听本身仍只绑 127.0.0.1。
	return fmt.Sprintf("http://gui.wails.localhost:%d%s?%st=%s", port, path, query, url.QueryEscape(token))
}

// uiWithAuth 只认两样：一次性的 ?t=<token>（换成 cookie 后 303 到干净地址），
// 或已经换好的 cookie。其余一律 401。
func uiWithAuth(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if q := r.URL.Query().Get("t"); q != "" {
			if subtle.ConstantTimeCompare([]byte(q), []byte(token)) != 1 {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			http.SetCookie(w, &http.Cookie{
				Name: uiCookie, Value: token, Path: "/", HttpOnly: true,
				SameSite: http.SameSiteLaxMode,
			})
			u := *r.URL
			qq := u.Query()
			qq.Del("t")
			u.RawQuery = qq.Encode()
			http.Redirect(w, r, u.RequestURI(), http.StatusSeeOther)
			return
		}
		if c, err := r.Cookie(uiCookie); err == nil &&
			subtle.ConstantTimeCompare([]byte(c.Value), []byte(token)) == 1 {
			next.ServeHTTP(w, r)
			return
		}
		http.Error(w, "forbidden", http.StatusForbidden)
	})
}

// ---------------------------------------------------------------------------
// Wails 同源的入口：只负责把 iframe 指到本地反代
// ---------------------------------------------------------------------------

/* UIHandler 包在 Wails 的 asset handler 外面。
 * /gwui 与 /gwui/ 只做一次 302：iframe 地址保持 /gwui/?view=providers，
 * 端口和 token 不写进前端的 HTML/JS。 */
type uiAssets struct {
	g      *Gateway
	assets http.Handler
}

// UIHandler 返回"先看 /gwui，其余交给 assets"的处理器。
func (g *Gateway) UIHandler(assets http.Handler) http.Handler {
	return uiAssets{g: g, assets: assets}
}

func (h uiAssets) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/gwui" || r.URL.Path == "/gwui/" {
		// 只接受页面请求；别的（子资源）本来也不该从这一层走。
		target := h.g.frameURL("/gwui/", r.URL.RawQuery)
		if target == "" {
			http.Error(w, "网关界面未就绪", http.StatusServiceUnavailable)
			return
		}
		http.Redirect(w, r, target, http.StatusFound)
		return
	}
	h.assets.ServeHTTP(w, r)
}

// ---------------------------------------------------------------------------
// 内嵌页的裁剪：只留网关的导航
// ---------------------------------------------------------------------------

/* uiEmbed 注入到 magpie 的 index.html（只在反代这一层，不改上游源码）。
 *
 * 1) 先写 magpie 自己的布局偏好 magpie.navLayout="top"：layoutNav() 读它，
 *    页面就用顶栏标签而不是左栏；不写死的话，#nav 会被搬进 #side，侧栏就
 *    又回来了（而且没法只用 CSS 藏 —— body 还会留 212px 的左内边距）。
 * 2) 再把不属于网关的导航拿掉：Agents / Sessions / Library（我们自己有总览
 *    和 Agent 页）、Settings、更新/同步/窗口按钮。视图 DOM 本身不动，magpie
 *    页面内自己的跳转仍然可用。 */
const uiEmbed = `<script>try{localStorage.setItem("magpie.navLayout","top")}catch(e){}
try{document.documentElement.dataset.theme="dark";document.title="Perch"}catch(e){}</script>
<style id="perch-embed">
#side,#sideEdge,#sideToggle,#prefs,#sync,#update,.update-wrap,#open,#openMain,#quit,#winclose,#ptabs{display:none!important}
#nav .nav-gl{display:none!important}
#nav button[data-view="agents"],#nav button[data-view="sessions"],#nav button[data-view="library"]{display:none!important}
/* 品牌区整个退场：logo + magpie 字样都不要。五个网关标签改为左对齐，
   和上面 Perch 的「面板 / 网关」页头同一条左基准线。 */
.brand{display:none!important}
.top .seg{position:relative!important;left:auto!important;top:auto!important;
          transform:none!important;margin-left:2px!important}
/* 把网关页的深蓝主题换成 Perch 的近黑中性色 + Perch 蓝。
   只覆盖变量，magpie 自己的组件结构、密度、交互都不动。 */
:root[data-theme="dark"]{
  color-scheme:dark;
  --bg:#0a0a0a; --card:#171717; --card-2:#121212;
  --pill:#1f1f1f; --pill-hover:#2a2a2a;
  --seg-track:rgba(255,255,255,.04); --seg-thumb:rgba(255,255,255,.12);
  --seg-edge:inset 0 .5px 0 rgba(255,255,255,.06),0 1px 2px rgba(0,0,0,.3);
  --line:rgba(255,255,255,.07); --line-2:rgba(255,255,255,.045);
  --fg:#fafafa; --fg-2:#d4d4d4; --muted:#a1a1a1; --faint:#737373; --ctl-fg:#a1a1a1;
  --accent:#4d6bfe; --accent-soft:rgba(77,107,254,.16); --accent-fg:#ffffff;
  --sel:rgba(77,107,254,.20);
  --green:#86efac; --green-soft:rgba(134,239,172,.12);
  --red:#ff6568; --red-soft:rgba(255,101,104,.12);
  --amber:#eab308; --amber-soft:rgba(234,179,8,.12);
  --drift:#ff6568; --drift-soft:rgba(255,101,104,.12);
  --pop-bg:rgba(23,23,23,.96);
  --shadow:0 16px 44px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.3),0 0 0 .5px rgba(255,255,255,.1);
  --logo-invert:1;
  --tk-s:#86efac; --tk-k:#c4b5fd; --tk-f:#93c5fd; --tk-n:#eab308; --tk-v:#67e8f9; --tk-o:#f0abfc; --tk-c:#737373;
  --c1:#6b8cff; --c2:#67e8f9; --c3:#86efac; --c4:#eab308; --c5:#f0abfc; --c6:#c4b5fd; --c7:#94a3b8;
  --font:"Geist","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
  --code:"Cascadia Code WB","JetBrains Mono WB",Consolas,"Microsoft YaHei",monospace;
}
/* Perch：供应商添加页不展示 magpie 的合作伙伴/赞助商货架。
   magpie 原文的归属是"赞助 magpie 的服务"，嵌进 Perch 后这层商业内容
   既不属于 Perch，也没有必要占一屏；只藏这一栏，订阅/供应商/中转照旧。
   data-perch-hide 由下面的脚本打在 .kind 和它后面的 .grid 上。 */
#addSheet [data-perch-hide]{display:none!important}
#addProvider.has-new::after{display:none!important}

/* Perch：路由页顶部的舞台动画讲的是 magpie 自己的路由叙事，和 Perch 的
   外壳混在一起；隐藏整段舞台/回放/标题说明，下面的请求历史、步骤日志、
   筛选和所有交互都保留。 */
#view-routing .rt-top,#view-routing .rt-stage,#view-routing .rt-replay{display:none!important}
</style>
<script>(function(){
  // Do not rewrite magpie's copy. The embedded page is magpie's own console;
  // its visible text must keep saying magpie (that is also what makes the
  // sponsor attribution truthful). Perch's own chrome is outside this iframe.
  //
  // The one thing Perch removes is the partner/sponsor shelf in the provider
  // add sheet: it is magpie's commercial listing, not part of this product.
  // The sheet is redrawn often, so sweep on mutations as well as once at boot.
  var partnerName=/^(partners?|合作伙伴|合作夥伴|パートナー|partner|sponsoren)$/i;
  var partnerHint=/sponsor|赞助|贊助|スポンサー|gesponsert/i;
  function sweep(){
    var kinds=document.querySelectorAll("#addSheet .kind");
    for(var i=0;i<kinds.length;i++){
      var k=kinds[i];
      if(k.getAttribute("data-perch-hide")) continue;
      var b=k.querySelector("b"), hint=k.querySelector("span");
      var name=(b&&b.textContent||"").trim();
      var h=(hint&&hint.textContent||"").trim();
      if(!partnerName.test(name) && !partnerHint.test(h)) continue;
      k.setAttribute("data-perch-hide","1");
      var g=k.nextElementSibling;
      if(g && g.classList && g.classList.contains("grid")) g.setAttribute("data-perch-hide","1");
    }
  }
  function start(){
    sweep();
    new MutationObserver(sweep).observe(document.documentElement,{subtree:true,childList:true});
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",start,{once:true});
  else start();

  // Tell Perch when this console writes provider/group/model/routing config.
  // The parent only treats this as a refresh signal; no keys or model data are
  // sent. Without it the parent cannot know that the iframe changed anything.
  function notifyChanged(){
    try {
      if(window.parent && window.parent!==window){
        window.parent.postMessage({type:"perch:gateway-changed"},"*");
      }
    } catch(e) {}
  }
  function isConfigWrite(url,method){
    method=String(method||"GET").toUpperCase();
    if(method==="GET"||method==="HEAD") return false;
    return /\/api\/(providers?|groups?|settings|agents?|models?|routing)\b/i.test(String(url||""));
  }
  if(window.fetch){
    var origFetch=window.fetch;
    window.fetch=function(input,init){
      var p=origFetch.apply(this,arguments);
      try{
        var url=typeof input==="string"?input:(input&&input.url)||"";
        var method=(init&&init.method)||(input&&input.method)||"GET";
        if(isConfigWrite(url,method)){
          p.then(function(r){ if(r&&r.ok) setTimeout(notifyChanged,0); },function(){});
        }
      }catch(e){}
      return p;
    };
  }
  if(window.XMLHttpRequest){
    var origOpen=window.XMLHttpRequest.prototype.open;
    var origSend=window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.open=function(method,url){
      this.__perchConfigWrite=isConfigWrite(url,method);
      return origOpen.apply(this,arguments);
    };
    window.XMLHttpRequest.prototype.send=function(){
      var xhr=this;
      if(xhr.__perchConfigWrite){
        xhr.addEventListener("load",function(){
          if(xhr.status>=200&&xhr.status<300) setTimeout(notifyChanged,0);
        });
      }
      return origSend.apply(this,arguments);
    };
  }
})();</script>
`

// uiEmbedHTML 在 </head> 前塞进 uiEmbed。读失败就原样放回，别让页面变空白。
func uiEmbedHTML(res *http.Response) error {
	if res.StatusCode != http.StatusOK ||
		!strings.HasPrefix(res.Header.Get("Content-Type"), "text/html") ||
		res.Header.Get("Content-Encoding") != "" {
		return nil
	}
	if res.Request == nil || res.Request.URL == nil {
		return nil
	}
	if p := res.Request.URL.Path; p != "/" && p != "/index.html" {
		return nil
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	res.Body.Close()
	if err != nil {
		res.Body = io.NopCloser(strings.NewReader(string(b)))
		return err
	}
	html := string(b)
	cut := false
	if !strings.Contains(html, "perch-embed") {
		if i := strings.Index(strings.ToLower(html), "</head>"); i >= 0 {
			html = html[:i] + uiEmbed + html[i:]
			cut = true
		}
	}
	if cut {
		log.Printf("[gwui] 内嵌页已裁剪：只留网关导航（%d -> %d 字节）", len(b), len(html))
	}
	res.Body = io.NopCloser(strings.NewReader(html))
	res.ContentLength = int64(len(html))
	res.Header.Set("Content-Length", strconv.Itoa(len(html)))
	// 页面本身不缓存：裁剪逻辑改了以后，重开就得看到新的。
	res.Header.Set("Cache-Control", "no-store")
	return nil
}

// ---------------------------------------------------------------------------
// 本地反代：/gwui/* 与 /api/* → magpie 控制面
// ---------------------------------------------------------------------------

type uiProxy struct{ g *Gateway }

func (p *uiProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/gwui":
		u := *r.URL
		u.Path = "/gwui/"
		http.Redirect(w, r, u.RequestURI(), http.StatusFound)
	case strings.HasPrefix(r.URL.Path, "/gwui/"):
		p.proxyTo(w, r, strings.TrimPrefix(r.URL.Path, "/gwui"), r.URL.RawQuery)
	case strings.HasPrefix(r.URL.Path, "/api/"):
		p.proxyTo(w, r, r.URL.Path, r.URL.RawQuery)
	default:
		http.NotFound(w, r)
	}
}

/* 每个请求都重新取一次端口/key：控制面可能刚被拉起、换过端口，或从外部接上。
 * key 只出现在发往本机 magpie 的 Cookie 头里。 */
func (p *uiProxy) proxyTo(w http.ResponseWriter, r *http.Request, path, rawQuery string) {
	port, key, client, _ := p.g.connState()
	if port <= 0 || key == "" || client == nil {
		http.Error(w, "magpie 控制面未接入", http.StatusServiceUnavailable)
		return
	}
	host := fmt.Sprintf("127.0.0.1:%d", port)
	target := &url.URL{Scheme: "http", Host: host}

	// 连接复用：把 gwClient 的 Transport 拿来，别给每个请求新建连接池。
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}

	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = target.Scheme
			pr.Out.URL.Host = target.Host
			pr.Out.Host = target.Host
			// 鉴权 cookie 由这里注入，浏览器里没有 magpie 的 key。
			pr.Out.Header.Set("Cookie", fmt.Sprintf("magpie_web_%d=%s", port, key))
			// 让 Go 的 Transport 自己协商并透明解压 gzip：magpie web 会压缩
			// 4MB 的页面（web.go:338）。
			pr.Out.Header.Del("Accept-Encoding")
		},
		Transport:     transport,
		FlushInterval: -1, // 流式响应（用量/插件安装的进度）不缓冲
		ModifyResponse: func(res *http.Response) error {
			if res.StatusCode >= 400 {
				log.Printf("[gwui] %s %s -> %d", res.Request.Method, res.Request.URL.Path, res.StatusCode)
			}
			// 页面（HTML）才裁剪；/api/* 原样透传。
			if err := uiEmbedHTML(res); err != nil {
				log.Printf("[gwui] 内嵌页注入失败：%v", err)
			}
			return nil
		},
		ErrorHandler: func(rw http.ResponseWriter, req *http.Request, err error) {
			// 只记路径与错误，不记 Cookie / key。
			log.Printf("[gwui] %s %s 失败：%v", req.Method, req.URL.Path, err)
			http.Error(rw, "magpie 控制面暂时不可用", http.StatusBadGateway)
		},
	}

	in := r.Clone(r.Context())
	in.URL.Path = path
	in.URL.RawPath = ""
	in.URL.RawQuery = rawQuery
	in.RequestURI = ""
	rp.ServeHTTP(w, in)
}
