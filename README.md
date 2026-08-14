# dsh-plugin-notify

DeepSeek Harness 插件：通知出口——让 agent 主动联系你。桌面通知 / 中文语音播报 / 提示音，Windows 本机零依赖。

## 功能

- **系统提示词注入**：自动往所有 agent 的系统提示词注入主动通知规则（长任务完成 / 出错 / 需要你注意时用 notify_user），不用每次教；`DSH_NOTIFY_INJECT_PROMPT=0` 可禁用
- **自动通知兜底**（不依赖模型自觉）：
  - 会话回合出错 → 自动语音 + 桌面通知
  - 回合结束 → 立即桌面通知，进入 60 秒确认窗口：期间你在 dsh 发了消息（=看到了）则取消；没发 → 中文语音呼叫你（**无论你在不在电脑前**——用电脑没发现任务完成更需要语音打断提醒）；`DSH_NOTIFY_ON_TURN_END=0` 关闭全部

- **agent 工具 `notify_user`**：**场景化调用**——模型只需传 `scene`（task_done / task_error / call_back）+ 可选 `summary`，文案由预设模板自动生成，不用自编语言；也可以 `message` 完全自定义
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
| `DSH_NOTIFY_ON_TURN_END` | `1` | 回合结束是否自动通知（`0` 关闭全部） |
| `DSH_NOTIFY_CALL_DELAY_SECONDS` | `60` | toast 发出后等待用户响应的秒数，超时未互动则语音呼叫 |
| `DSH_NOTIFY_TEMPLATE_DONE` 等 | 默认模板 | 文案模板（task_done / task_error / call_back），也可写 `~/.dsh/notify/templates.json` 覆盖 |

## 文案模板

模型调用  时不用自己编语言，按场景自动生成（支持  结果摘要、 会话 id 变量）：

| 场景 | 默认文案 |
|---|---|
|  | 任务已经完成了，快回来看看结果吧{{summary}} |
|  | 任务出错了，需要你处理一下{{summary}} |
|  | 我需要你过来看看{{summary}} |

自定义（优先级：配置文件 > 环境变量 > 默认）：



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
