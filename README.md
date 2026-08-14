# dsh-plugin-notify

DeepSeek Harness 插件：通知出口——让 agent 主动联系你。桌面通知 / 中文语音播报 / 提示音，Windows 本机零依赖。

## 功能

- **系统提示词注入**：自动往所有 agent 的系统提示词注入主动通知规则（长任务完成 / 出错 / 需要你注意时用 notify_user），不用每次教；`DSH_NOTIFY_INJECT_PROMPT=0` 可禁用
- **自动通知兜底**（不依赖模型自觉）：
  - 会话回合出错 → 自动语音 + 桌面通知
  - 回合结束 → 自动桌面通知（`DSH_NOTIFY_ON_TURN_END=0` 关闭）

- **agent 工具 `notify_user`**：模型自主决定何时通知你——长任务完成、出错、需要你确认、你不在电脑前时呼叫你回来（"任务做完了叫你"）
- **命令 `/notify`**：`/notify <内容> [--speak|--sound|--toast]` 手动发通知
- **测试页**：`http://<dsh地址>:<端口>/notify` 一键测试四种模式
- **三种通道**（可组合）：
  - `toast` 桌面通知（NotifyIcon 气泡，无额外模块）
  - `speak` 中文语音播报（PowerShell SAPI 离线 TTS，优先中文语音）
  - `sound` 系统提示音
  - `both` 语音 + 桌面通知

## 安装

```bash
npm i dsh-plugin-notify
```

在 dsh 的 profile patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`）中挂载：

```yaml
- insert:
    - id: notify
      name: 'dsh-plugin-notify'
```

重启 dsh 即生效。要求 Windows + PowerShell 5.1+（系统自带）。

## 使用

**模型主动通知**（核心场景）：直接跟 agent 说"做完这个任务通知我""出错时叫我"，它会调用 `notify_user` 工具。语音播报会念出内容（自动截断 300 字），适合你离开电脑时的场景：

> "查一下今天的项目状态，完成后用语音叫我"

**手动通知**：

```
/notify 任务完成了
/notify --speak 快回来看看结果
/notify --sound 提醒
```

**测试页**：浏览器打开 `/notify`，选模式点发送；"演示：任务完成叫你"一键体验完整场景。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_NOTIFY_DEFAULT_MODE` | `toast` | 默认通知方式（`toast` / `speak` / `sound` / `both`） |
| `DSH_NOTIFY_INJECT_PROMPT` | `1` | 是否向系统提示词注入"主动通知"规则（`0` 关闭） |
| `DSH_NOTIFY_ON_TURN_END` | `1` | 回合结束是否自动桌面通知（`0` 关闭） |

## 实现说明

- 后端是单文件 `notify.ps1`（随包分发），通过环境变量 `DSH_NOTIFY_PAYLOAD` 接收 base64 编码的 JSON（避免命令行中文编码问题）
- 语音用系统 SAPI：自动选择 `zh-CN` 语音（如 Microsoft Huihui Desktop），无中文语音时回退默认
- 语音播报同步执行（念完才返回），工具调用串行，超时 120 秒

## 开发

```bash
npm run build   # esbuild 构建 lib/
# 单测后端：DSH_NOTIFY_PAYLOAD=$(node -e "console.log(Buffer.from(JSON.stringify({mode:'speak',title:'测试',message:'你好'})).toString('base64'))") powershell -File notify.ps1
```

## 许可

MIT
