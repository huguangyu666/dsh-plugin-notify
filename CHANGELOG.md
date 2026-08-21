# Changelog

## [0.1.2] - 2026-08-21

### Fixed
- 通知改为异步子进程执行，不再用 `spawnSync` 阻塞 dsh 事件循环；修复报错/回合结束时语音播报导致 Web UI 卡顿、打断延迟大、无法及时中止的问题

## [0.1.1] - 2026-08-15

### Changed
- 页面 UI 改为 dsh 原生风格（--dsw-alias-* token，明暗自适应）

### Added
- 测试 22 项（mock 14 + 音效文件 8）
