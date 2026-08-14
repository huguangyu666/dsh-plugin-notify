/**
 * dsh-plugin-notify client 端：往 dsh 设置界面（settings.section slot）注册"通知"分区。
 * 表单通过 host 的 /notify/api/settings 读写（与 /notify 页面共用同一配置）。
 * 样式使用 dsh 设计系统变量（--dsw-alias-*），自动适配明暗主题。
 */
const React = require("react");
const { useState, useEffect } = React;

/** dsh 设计系统变量（自动适配主题，不写死颜色） */
const DSW = (v) => `var(--dsw-alias-${v})`;

/** 通知设置表单（嵌入 dsh 设置界面的分区） */
function NotifySettingsSection() {
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const load = async () => {
    try {
      const r = await fetch("/notify/api/settings");
      const d = await r.json();
      if (d.config) setCfg(d.config);
    } catch (e) { setMsg("读取失败: " + e.message); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    setMsg("");
    try {
      const r = await fetch("/notify/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      const d = await r.json().catch(() => ({}));
      setMsg(r.ok ? "已保存，立即生效" : ("保存失败: " + (d.error || r.status)));
    } catch (e) { setMsg("保存失败: " + e.message); }
    setSaving(false);
  };

  if (!cfg) {
    return React.createElement("div", { style: { color: DSW("label-tertiary"), fontSize: "13px", padding: "12px 0" } }, "加载中…");
  }

  const set = (key, value) => setCfg((c) => ({ ...c, [key]: value }));
  const setTpl = (key, value) => setCfg((c) => ({ ...c, templates: { ...c.templates, [key]: value } }));

  const styles = {
    row: { display: "flex", alignItems: "center", gap: "10px", margin: "10px 0", fontSize: "13px" },
    label: { color: DSW("label-secondary"), width: "130px", flex: "none", fontSize: "12.5px" },
    input: { flex: "1", background: DSW("bg-module-platform"), border: "1px solid " + DSW("border-l2"), color: DSW("label-primary"), borderRadius: "8px", padding: "7px 10px", fontSize: "13px", outline: "none", maxWidth: "240px", fontFamily: DSW("font-family") },
    textarea: { width: "100%", background: DSW("bg-module-platform"), border: "1px solid " + DSW("border-l2"), color: DSW("label-primary"), borderRadius: "8px", padding: "8px 10px", fontSize: "12.5px", outline: "none", resize: "vertical", minHeight: "52px", marginTop: "4px", fontFamily: DSW("font-family") },
    tplLabel: { color: DSW("label-tertiary"), fontSize: "12px", marginTop: "14px" },
    switchRow: { display: "flex", alignItems: "center", gap: "10px", margin: "8px 0", fontSize: "13px" },
    switchLabel: { color: DSW("label-primary"), cursor: "pointer", fontSize: "12.5px" },
    btn: { background: DSW("button-info-fill"), border: "none", color: "#fff", borderRadius: "8px", padding: "8px 22px", fontSize: "13px", cursor: "pointer", marginTop: "14px", fontWeight: 500 },
    btnHover: { background: DSW("button-info-hover") },
    msg: { color: DSW("label-secondary"), fontSize: "12px", marginTop: "8px", marginLeft: "10px" },
    hint: { color: DSW("label-tertiary"), fontSize: "11.5px", marginTop: "6px" },
    accent: { color: DSW("brand-primary") },
  };

  return React.createElement("div", null,
    React.createElement("div", { style: styles.row },
      React.createElement("span", { style: styles.label }, "默认通知方式"),
      React.createElement("select", { style: styles.input, value: cfg.defaultMode || "toast", onChange: (e) => set("defaultMode", e.target.value) },
        React.createElement("option", { value: "toast" }, "桌面通知"),
        React.createElement("option", { value: "speak" }, "语音播报"),
        React.createElement("option", { value: "sound" }, "提示音"),
        React.createElement("option", { value: "both" }, "语音 + 桌面"))),
    React.createElement("div", { style: styles.row },
      React.createElement("span", { style: styles.label }, "确认窗口（秒）"),
      React.createElement("input", { type: "number", min: 5, max: 600, style: styles.input, value: cfg.callDelaySeconds ?? 60, onChange: (e) => set("callDelaySeconds", Number(e.target.value) || 60) })),
    React.createElement("div", { style: styles.row },
      React.createElement("span", { style: styles.label }, "通知音效"),
      React.createElement("select", { style: styles.input, value: cfg.soundEffect || "explode", onChange: (e) => set("soundEffect", e.target.value) },
        React.createElement("option", { value: "explode" }, "炸裂"),
        React.createElement("option", { value: "success" }, "胜利"),
        React.createElement("option", { value: "alarm" }, "警报"),
        React.createElement("option", { value: "notify" }, "清脆"),
        React.createElement("option", { value: "system" }, "系统提示音"))),
    React.createElement("div", { style: styles.switchRow },
      React.createElement("input", { type: "checkbox", id: "nt-turend", checked: !!cfg.onTurnEnd, onChange: (e) => set("onTurnEnd", e.target.checked) }),
      React.createElement("label", { htmlFor: "nt-turend", style: styles.switchLabel }, "回合结束自动通知（toast → 确认窗口 → 无人回应语音呼叫）")),
    React.createElement("div", { style: styles.switchRow },
      React.createElement("input", { type: "checkbox", id: "nt-autocall", checked: !!cfg.autoCall, onChange: (e) => set("autoCall", e.target.checked) }),
      React.createElement("label", { htmlFor: "nt-autocall", style: styles.switchLabel }, "确认窗口超时后语音呼叫用户")),
    React.createElement("div", { style: styles.switchRow },
      React.createElement("input", { type: "checkbox", id: "nt-boost", checked: !!cfg.boostVolume, onChange: (e) => set("boostVolume", e.target.checked) }),
      React.createElement("label", { htmlFor: "nt-boost", style: styles.switchLabel }, "通知时把音量调到最大，播完恢复（语音呼叫更响亮）")),
    React.createElement("div", { style: styles.tplLabel }, "文案模板（模型不写 message 时使用；支持 {{summary}} / {{session}}）"),
    React.createElement("textarea", { style: styles.textarea, value: cfg.templates?.task_done || "", placeholder: "任务完成", onChange: (e) => setTpl("task_done", e.target.value) }),
    React.createElement("textarea", { style: styles.textarea, value: cfg.templates?.task_error || "", placeholder: "任务出错", onChange: (e) => setTpl("task_error", e.target.value) }),
    React.createElement("textarea", { style: styles.textarea, value: cfg.templates?.call_back || "", placeholder: "呼叫用户", onChange: (e) => setTpl("call_back", e.target.value) }),
    React.createElement("button", { style: styles.btn, disabled: saving, onClick: save }, saving ? "保存中…" : "保存设置"),
    React.createElement("span", { style: styles.msg }, msg));
}

const name = "dsh-plugin-notify";
const inject = ["slots"];

function apply(ctx) {
  ctx.effect(() =>
    ctx.slots.register(
      { name: "settings.section", id: "notify", order: 100, label: "通知" },
      NotifySettingsSection,
    ));
}

module.exports = { name, inject, apply };
