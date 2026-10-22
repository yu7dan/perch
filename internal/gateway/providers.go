package gateway

// Native provider/credential surface for the built-in engine.
//
// The engine's provider API is the source of truth. Perch normalizes it into
// these types; the UI never sees provider keys, only a mask and a status. A
// save/test is always a direct result of a user action in the gateway page.

import (
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"strings"
	"time"

	"github.com/yu7dan/perch/internal/uimsg"
)

type ProviderModel struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Context int    `json:"context"`
	Output  int    `json:"output"`
	Tools   bool   `json:"tools"`
	Images  bool   `json:"images"`
	// On is whether the user picked it. No model on = the vendor's list.
	On bool `json:"on,omitempty"`
}

// ProviderAgent is one agent currently pointed at this provider. It is a
// read-only cross-link: clicking it in the UI opens that agent in Overview.
type ProviderAgent struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Icon    string `json:"icon,omitempty"`
	Current bool   `json:"current"`
	Model   string `json:"model,omitempty"`
}

type ProviderInfo struct {
	ID            string          `json:"id"`
	Name          string          `json:"name"`
	Icon          string          `json:"icon,omitempty"`
	Protocol      string          `json:"protocol"`
	BaseURL       string          `json:"baseUrl"`
	Host          string          `json:"host,omitempty"`
	Preset        string          `json:"preset,omitempty"`
	Website       string          `json:"website,omitempty"`
	KeyConfigured bool            `json:"keyConfigured"`
	KeyMasked     string          `json:"keyMasked,omitempty"`
	KeyStatus     string          `json:"keyStatus"` // missing | untested | ok
	KeyOptional   bool            `json:"keyOptional,omitempty"`
	Ready         bool            `json:"ready"`
	Models        []ProviderModel `json:"models"`
	Agents        []ProviderAgent `json:"agents,omitempty"`
}

// ProviderPresetRegion is one base-URL choice of a vendor preset.
type ProviderPresetRegion struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Chat      string `json:"chat,omitempty"`
	Responses string `json:"responses,omitempty"`
	Anthropic string `json:"anthropic,omitempty"`
	KeysURL   string `json:"keysUrl,omitempty"`
	Website   string `json:"website,omitempty"`
}

// ProviderPresetInfo is a normalized vendor template from the engine. It is
// deliberately data only: the frontend renders it as a tile and prefills the
// editor; the engine remains the source of truth for endpoints and models.
type ProviderPresetInfo struct {
	ID             string                 `json:"id"`
	Name           string                 `json:"name"`
	Short          string                 `json:"short,omitempty"`
	Icon           string                 `json:"icon,omitempty"`
	Kind           string                 `json:"kind"` // vendor | relay | local
	Note           string                 `json:"note,omitempty"`
	Website        string                 `json:"website,omitempty"`
	KeysURL        string                 `json:"keysUrl,omitempty"`
	NoKey          bool                   `json:"noKey,omitempty"`
	KeyHint        string                 `json:"keyHint,omitempty"`
	Chat           string                 `json:"chat,omitempty"`
	Responses      string                 `json:"responses,omitempty"`
	Anthropic      string                 `json:"anthropic,omitempty"`
	Gemini         string                 `json:"gemini,omitempty"`
	Regions        []ProviderPresetRegion `json:"regions,omitempty"`
	RegionLabel    string                 `json:"regionLabel,omitempty"`
	Endpoint       string                 `json:"endpoint,omitempty"`
	EndpointHint   string                 `json:"endpointHint,omitempty"`
	EndpointNeeded string                 `json:"endpointNeeded,omitempty"`
	Models         []string               `json:"models,omitempty"`
	NoList         bool                   `json:"noList,omitempty"`
	Only           string                 `json:"only,omitempty"`
	Added          bool                   `json:"added"`
}

type ProviderInput struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Preset    string            `json:"preset"`
	Protocol  string            `json:"protocol"`
	BaseURL   string            `json:"baseUrl"`
	Key       string            `json:"key"`
	Models    []string          `json:"models"`
	Endpoints map[string]string `json:"endpoints"`
}

type CredentialSummary struct {
	Configured bool   `json:"configured"`
	Masked     string `json:"masked,omitempty"`
	Status     string `json:"status"` // missing | untested | ok
	LastError  string `json:"lastError,omitempty"`
}

type TestResult struct {
	OK     bool              `json:"ok"`
	Status string            `json:"status"`
	Code   string            `json:"code,omitempty"`
	Params map[string]string `json:"params,omitempty"`
	Error  string            `json:"error,omitempty"`
}

type providerKeyWire struct {
	Set      bool   `json:"set"`
	Masked   string `json:"masked"`
	Optional bool   `json:"optional"`
}

type providerModelWire struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Context int    `json:"context"`
	Output  int    `json:"output"`
	Images  bool   `json:"images"`
	NoAPI   bool   `json:"noAPI"`
	On      bool   `json:"on"`
}

type providerAgentWire struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Icon    string `json:"icon"`
	Current bool   `json:"current"`
	Model   string `json:"model"`
}

type providerRow struct {
	ID        string              `json:"id"`
	Name      string              `json:"name"`
	Icon      string              `json:"icon"`
	Preset    string              `json:"preset"`
	Host      string              `json:"host"`
	Chat      string              `json:"chat"`
	Responses string              `json:"responses"`
	Anthropic string              `json:"anthropic"`
	Gemini    string              `json:"gemini"`
	Website   string              `json:"website"`
	KeysURL   string              `json:"keysUrl"`
	Key       providerKeyWire     `json:"key"`
	Models    []providerModelWire `json:"models"`
	Agents    []providerAgentWire `json:"agents"`
	Ready     bool                `json:"ready"`
}

type presetRegionWire struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Chat      string `json:"chat"`
	Responses string `json:"responses"`
	Anthropic string `json:"anthropic"`
	KeysURL   string `json:"keysUrl"`
	Website   string `json:"website"`
}

type providerPresetRow struct {
	ID             string             `json:"id"`
	Name           string             `json:"name"`
	Short          string             `json:"short"`
	Icon           string             `json:"icon"`
	Kind           string             `json:"kind"`
	Chat           string             `json:"chat"`
	Responses      string             `json:"responses"`
	Anthropic      string             `json:"anthropic"`
	Gemini         string             `json:"gemini"`
	Decide         string             `json:"decide"`
	Note           string             `json:"note"`
	Website        string             `json:"website"`
	KeysURL        string             `json:"keysUrl"`
	NoKey          bool               `json:"noKey"`
	KeyHint        string             `json:"keyHint"`
	Sponsored      bool               `json:"sponsored"`
	Vertex         bool               `json:"vertex"`
	Endpoint       string             `json:"endpoint"`
	EndpointHint   string             `json:"endpointHint"`
	EndpointNeeded string             `json:"endpointNeeded"`
	RegionLabel    string             `json:"regionLabel"`
	Regions        []presetRegionWire `json:"regions"`
	Models         []string           `json:"models"`
	NoList         bool               `json:"noList"`
	Only           string             `json:"only"`
	Added          bool               `json:"added"`
}

type providerWire struct {
	Providers []providerRow       `json:"providers"`
	Presets   []providerPresetRow `json:"presets"`
}

func (g *Gateway) providerWire() (providerWire, error) {
	if err := g.Ensure(); err != nil {
		return providerWire{}, err
	}
	b, err := g.API("GET", "/api/providers", nil)
	if err != nil {
		return providerWire{}, err
	}
	var p providerWire
	if err := json.Unmarshal(b, &p); err != nil {
		return providerWire{}, uimsg.New("gw.badProviders", "网关返回了无法读取的供应商列表")
	}
	return p, nil
}

func protocolOfProvider(p providerRow) (protocol, base string) {
	switch {
	case p.Anthropic != "":
		return "anthropic", p.Anthropic
	case p.Gemini != "":
		return "gemini", p.Gemini
	case p.Chat != "":
		return "openai", p.Chat
	default:
		return "responses", p.Responses
	}
}

func providerInfo(p providerRow) ProviderInfo {
	protocol, base := protocolOfProvider(p)
	// 引擎的 ready 只说明“这个供应商现在可用”（有 key、有模型），它不是
	// “key 验证通过”的证据。没有真的点过测试时，状态必须是 untested。
	status := "missing"
	if p.Key.Set {
		status = "untested"
	}
	out := ProviderInfo{
		ID: p.ID, Name: p.Name, Icon: p.Icon, Protocol: protocol, BaseURL: base,
		Host: p.Host, Preset: p.Preset, Website: p.Website,
		KeyConfigured: p.Key.Set, KeyMasked: p.Key.Masked, KeyStatus: status,
		KeyOptional: p.Key.Optional, Ready: p.Ready,
		Models: []ProviderModel{}, Agents: []ProviderAgent{},
	}
	for _, m := range p.Models {
		out.Models = append(out.Models, ProviderModel{
			ID: m.ID, Label: firstNonEmpty(m.Name, m.ID), Context: m.Context,
			Output: m.Output, Tools: !m.NoAPI, Images: m.Images, On: m.On,
		})
	}
	for _, a := range p.Agents {
		out.Agents = append(out.Agents, ProviderAgent{
			ID: a.ID, Name: a.Name, Icon: a.Icon, Current: a.Current, Model: a.Model,
		})
	}
	return out
}

// presetSupported is the v1 catalog's boundary: a single API key (or no key
// for a local server) is enough. Presets that need Google credentials, a
// sponsored slot, or a decision-only API have no editor here yet, so they are
// left out rather than shown as a tile that cannot be finished.
func presetSupported(p providerPresetRow) bool {
	if p.Kind != "vendor" && p.Kind != "relay" && p.Kind != "local" {
		return false
	}
	if p.Sponsored || p.Vertex {
		return false
	}
	if p.Decide != "" && p.Chat == "" && p.Responses == "" && p.Anthropic == "" && p.Gemini == "" {
		return false
	}
	if p.Chat == "" && p.Responses == "" && p.Anthropic == "" && p.Gemini == "" && p.Endpoint == "" && p.Kind != "local" {
		return false
	}
	return true
}

func presetInfo(p providerPresetRow) ProviderPresetInfo {
	out := ProviderPresetInfo{
		ID: p.ID, Name: p.Name, Short: p.Short, Icon: p.Icon, Kind: p.Kind,
		Note: p.Note, Website: p.Website, KeysURL: p.KeysURL,
		NoKey: p.NoKey, KeyHint: p.KeyHint,
		Chat: p.Chat, Responses: p.Responses, Anthropic: p.Anthropic, Gemini: p.Gemini,
		RegionLabel: p.RegionLabel, Endpoint: p.Endpoint,
		EndpointHint: p.EndpointHint, EndpointNeeded: p.EndpointNeeded,
		Models: p.Models, NoList: p.NoList, Only: p.Only, Added: p.Added,
	}
	for _, r := range p.Regions {
		out.Regions = append(out.Regions, ProviderPresetRegion{
			ID: r.ID, Name: r.Name, Chat: r.Chat, Responses: r.Responses,
			Anthropic: r.Anthropic, KeysURL: r.KeysURL, Website: r.Website,
		})
	}
	return out
}

// providerCatalog returns providers and the supported preset catalog from one
// engine read. One call keeps the two lists from disagreeing about "added".
func (g *Gateway) providerCatalog() ([]ProviderInfo, []ProviderPresetInfo, error) {
	w, err := g.providerWire()
	if err != nil {
		return nil, nil, err
	}
	providers := make([]ProviderInfo, 0, len(w.Providers))
	have := make(map[string]bool, len(w.Providers)*2)
	for _, p := range w.Providers {
		providers = append(providers, providerInfo(p))
		have[p.ID] = true
		if p.Preset != "" {
			have[p.Preset] = true
		}
	}
	presets := make([]ProviderPresetInfo, 0, len(w.Presets))
	for _, p := range w.Presets {
		if !presetSupported(p) {
			continue
		}
		info := presetInfo(p)
		info.Added = info.Added || have[p.ID]
		presets = append(presets, info)
	}
	return providers, presets, nil
}

func (g *Gateway) providerList() ([]ProviderInfo, error) {
	ps, _, err := g.providerCatalog()
	return ps, err
}

func (g *Gateway) pushProviders(op string) {
	ps, presets, err := g.providerCatalog()
	m := map[string]any{"type": "gw.providers", "op": op, "at": nowISO()}
	if err != nil {
		m["error"] = err.Error()
	} else {
		m["providers"] = ps
		m["presets"] = presets
	}
	g.emit(uimsg.Fields(m, err))
}

// ProviderList is the read behind the gateway's provider page.
func (g *Gateway) ProviderList() {
	g.pushProviders("list")
}

func (g *Gateway) findProvider(id string) (ProviderInfo, bool, error) {
	ps, err := g.providerList()
	if err != nil {
		return ProviderInfo{}, false, err
	}
	for _, p := range ps {
		if p.ID == id {
			return p, true, nil
		}
	}
	return ProviderInfo{}, false, nil
}

// SaveProvider creates/updates a provider. A preset needs only an id, a key
// and (optionally) a model pick; a custom provider keeps the protocol/base
// form. The key is part of the same save because the engine owns the
// credential; it is never echoed.
func (g *Gateway) SaveProvider(in ProviderInput) {
	if err := g.Ensure(); err != nil {
		g.pushProviderErr("save", err)
		return
	}
	if strings.TrimSpace(in.Preset) != "" {
		g.savePresetProvider(in)
		return
	}
	g.saveCustomProvider(in)
}

func (g *Gateway) savePresetProvider(in ProviderInput) {
	presetID := strings.TrimSpace(in.Preset)
	_, presets, err := g.providerCatalog()
	if err != nil {
		g.pushProviderErr("save", err)
		return
	}
	var preset ProviderPresetInfo
	found := false
	for _, p := range presets {
		if p.ID == presetID {
			preset, found = p, true
			break
		}
	}
	if !found {
		g.pushProviderErrCode("save", "gw.presetMissing", "这个供应商模板已经不可用")
		return
	}

	id := strings.TrimSpace(in.ID)
	isNew := id == ""
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = preset.Name
	}
	if id == "" {
		id = preset.ID
	}
	if !isNew {
		if existing, ok, err := g.findProvider(id); err != nil {
			g.pushProviderErr("save", err)
			return
		} else if !ok {
			g.pushProviderErrCode("save", "gw.providerMissing", "供应商不存在")
			return
		} else if strings.TrimSpace(in.Name) == "" {
			name = existing.Name
		}
	}
	key := in.Key
	if isNew && !preset.NoKey && strings.TrimSpace(key) == "" {
		g.pushProviderErrCode("save", "gw.providerKeyRequired", "这个供应商需要 API key")
		return
	}
	payload := map[string]any{
		"id": id, "name": name, "preset": presetID, "new": isNew,
	}
	if key != "" {
		payload["key"] = key
	}
	endpoints, err := cleanProviderEndpoints(in.Endpoints)
	if err != nil {
		g.pushProviderErrCode("save", "gw.providerBaseBad", "供应商地址必须以 http:// 或 https:// 开头")
		return
	}
	if preset.Endpoint != "" && len(endpoints) == 0 {
		g.pushProviderErrCode("save", "gw.providerEndpointRequired", "这个供应商需要先填写 Endpoint")
		return
	}
	for k, v := range endpoints {
		payload[k] = v
	}
	// A region/endpoint bypasses the engine's FromPreset fill. Carry the
	// preset's fixed model list when it has one so a no-list vendor still
	// exposes its models.
	if in.Models != nil {
		payload["models"] = cleanProviderModels(in.Models)
	} else if len(endpoints) > 0 && preset.NoList && len(preset.Models) > 0 {
		payload["models"] = preset.Models
	}
	if _, err := g.API("POST", "/api/provider/save", payload); err != nil {
		g.pushProviderErrCode("save", "gw.providerSaveFailed", "保存供应商失败")
		return
	}
	p, ok, err := g.findProviderAfterSave(id, presetID, name)
	if err != nil {
		g.pushProviderErr("save", err)
		return
	}
	if !ok {
		g.pushProviderErrCode("save", "gw.providerMissing", "供应商已保存，但网关没有返回它")
		return
	}
	g.emit(map[string]any{"type": "gw.provider.saved", "provider": p, "at": nowISO()})
	g.pushProviders("save")
}

func (g *Gateway) saveCustomProvider(in ProviderInput) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		g.pushProviderErrCode("save", "gw.providerNameRequired", "供应商名称不能为空")
		return
	}
	protocol := strings.ToLower(strings.TrimSpace(in.Protocol))
	if protocol == "" {
		protocol = "openai"
	}
	if protocol != "openai" && protocol != "responses" && protocol != "anthropic" && protocol != "gemini" {
		g.pushProviderErrCode("save", "gw.providerProtocolBad", "协议必须是 openai、responses、anthropic 或 gemini")
		return
	}
	base := strings.TrimSpace(in.BaseURL)
	if base == "" {
		base = defaultProviderBase(protocol)
	}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		g.pushProviderErrCode("save", "gw.providerBaseBad", "Base URL 必须以 http:// 或 https:// 开头")
		return
	}
	id := strings.TrimSpace(in.ID)
	isNew := id == ""
	if id == "" {
		id = providerSlug(name)
	}
	payload := map[string]any{
		"id": id, "name": name, "new": isNew, "baseAPI": protocol,
	}
	// 编辑时留空 = 保留已保存的密钥；只有真的填了才把 key 交给引擎。
	if in.Key != "" {
		payload["key"] = in.Key
	}
	switch protocol {
	case "anthropic":
		payload["anthropic"] = base
	case "gemini":
		payload["gemini"] = base
	case "responses":
		payload["responses"] = base
	default:
		payload["chat"] = base
	}
	models := cleanProviderModels(in.Models)
	if len(models) > 0 {
		payload["models"] = models
	}
	if _, err := g.API("POST", "/api/provider/save", payload); err != nil {
		g.pushProviderErrCode("save", "gw.providerSaveFailed", "保存供应商失败")
		return
	}
	p, ok, err := g.findProviderAfterSave(id, "", name)
	if err != nil {
		g.pushProviderErr("save", err)
		return
	}
	if !ok {
		g.pushProviderErrCode("save", "gw.providerMissing", "供应商已保存，但网关没有返回它")
		return
	}
	g.emit(map[string]any{"type": "gw.provider.saved", "provider": p, "at": nowISO()})
	g.pushProviders("save")
}

func cleanProviderModels(in []string) []string {
	out := make([]string, 0, len(in))
	for _, m := range in {
		if m = strings.TrimSpace(m); m != "" {
			out = append(out, m)
		}
	}
	return out
}

func cleanProviderEndpoints(in map[string]string) (map[string]string, error) {
	out := map[string]string{}
	for k, v := range in {
		switch k {
		case "chat", "responses", "anthropic", "gemini", "decide":
		default:
			continue
		}
		v = strings.TrimRight(strings.TrimSpace(v), "/")
		if v == "" {
			continue
		}
		if !strings.HasPrefix(v, "http://") && !strings.HasPrefix(v, "https://") {
			return nil, fmt.Errorf("bad endpoint")
		}
		out[k] = v
	}
	return out, nil
}

func (g *Gateway) findProviderAfterSave(id, preset, name string) (ProviderInfo, bool, error) {
	ps, _, err := g.providerCatalog()
	if err != nil {
		return ProviderInfo{}, false, err
	}
	if id != "" {
		for _, p := range ps {
			if p.ID == id {
				return p, true, nil
			}
		}
	}
	if preset != "" {
		for _, p := range ps {
			if p.Preset == preset {
				return p, true, nil
			}
		}
	}
	if name != "" {
		for _, p := range ps {
			if p.Name == name {
				return p, true, nil
			}
		}
	}
	return ProviderInfo{}, false, nil
}

func (g *Gateway) TestCredential(providerID, credentialID string) {
	providerID = strings.TrimSpace(providerID)
	if providerID == "" {
		g.pushProviderErr("test", uimsg.New("gw.providerRequired", "缺少供应商"))
		return
	}
	if err := g.Ensure(); err != nil {
		g.pushProviderErr("test", err)
		return
	}
	payload := map[string]any{"id": providerID}
	if credentialID = strings.TrimSpace(credentialID); credentialID != "" {
		payload["account"] = credentialID
	}
	out := map[string]any{"type": "gw.credential.test", "providerId": providerID, "at": nowISO()}
	b, err := g.API("POST", "/api/provider/test", payload)
	if err != nil {
		// The upstream body of a failed test can echo the key. Do not put the
		// error text (or its params) on the wire; the UI gets a stable code.
		log.Printf("[gw] 供应商测试请求失败：%T", err)
		out["result"] = TestResult{OK: false, Status: "error",
			Code: "gw.keyTestRequestFailed", Error: "密钥测试请求失败"}
		g.emit(out)
		return
	}
	// The engine answers HTTP 200 with per-protocol results; a failed key is
	// ok:false inside the body. Upstream error text can contain the key itself
	// (OpenAI says "Incorrect API key provided: sk-..."), so it never leaves Go:
	// the UI gets a stable code + status and renders it in the user's language.
	var tr struct {
		Results []struct {
			Protocol string `json:"protocol"`
			OK       bool   `json:"ok"`
			Status   int    `json:"status"`
		} `json:"results"`
	}
	_ = json.Unmarshal(b, &tr)
	if len(tr.Results) == 0 {
		out["result"] = TestResult{OK: false, Status: "invalid",
			Code: "gw.keyTestNoResult", Error: "供应商没有返回测试结果"}
		g.emit(out)
		return
	}
	ok := true
	code, text, params := "", "", map[string]string(nil)
	for _, r := range tr.Results {
		if r.OK {
			continue
		}
		ok = false
		status := fmt.Sprintf("%d", r.Status)
		params = map[string]string{"status": status}
		switch {
		case r.Status == 401 || r.Status == 403:
			code, text = "gw.keyRejected", "供应商拒绝了这枚密钥（HTTP "+status+"）"
		case r.Status == 429:
			code, text = "gw.keyRateLimited", "供应商限流（HTTP 429）"
		case r.Status >= 500:
			code, text = "gw.providerUnavailable", "供应商暂时不可用（HTTP "+status+"）"
		case r.Status == 0:
			code, text = "gw.keyTestNetwork", "测试请求没有到达供应商"
		default:
			code, text = "gw.keyTestFailed", "密钥测试失败（HTTP "+status+"）"
		}
		break
	}
	if ok {
		out["result"] = TestResult{OK: true, Status: "ok"}
	} else {
		out["result"] = TestResult{OK: false, Status: "invalid", Code: code, Params: params, Error: text}
	}
	g.emit(out)
}

func (g *Gateway) DeleteProvider(providerID string) {
	providerID = strings.TrimSpace(providerID)
	if providerID == "" {
		g.pushProviderErr("delete", uimsg.New("gw.providerRequired", "缺少供应商"))
		return
	}
	if err := g.Ensure(); err != nil {
		g.pushProviderErr("delete", err)
		return
	}
	if _, err := g.API("POST", "/api/provider/delete", map[string]any{"id": providerID}); err != nil {
		g.pushProviderErrCode("delete", "gw.providerDeleteFailed", "删除供应商失败")
		return
	}
	g.emit(map[string]any{"type": "gw.provider.deleted", "providerId": providerID, "at": nowISO()})
	g.pushProviders("delete")
}

func (g *Gateway) pushProviderErr(op string, err error) {
	g.emit(uimsg.Fields(map[string]any{
		"type": "gw.provider.error", "op": op, "at": nowISO(),
	}, err))
}

func (g *Gateway) pushProviderErrCode(op, code, text string) {
	g.pushProviderErr(op, uimsg.New(code, text))
}

func providerSlug(s string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		case !lastDash:
			b.WriteByte('-')
			lastDash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return fmt.Sprintf("provider-%d", time.Now().Unix())
	}
	return out
}

func defaultProviderBase(protocol string) string {
	switch protocol {
	case "anthropic":
		return "https://api.anthropic.com"
	case "gemini":
		return "https://generativelanguage.googleapis.com/v1beta"
	case "responses":
		return "https://api.openai.com/v1"
	default:
		return "https://api.openai.com/v1"
	}
}

// providerIconURL is kept for the UI: provider icons are served by the engine
// under /api/icons; the native page can use the icon id as-is and let the
// engine's icon route be proxied later. For v1 the page falls back to a glyph.
func providerIconURL(base, icon string) string {
	if base == "" || icon == "" {
		return ""
	}
	return strings.TrimRight(base, "/") + "/api/icons/" + url.PathEscape(icon)
}
