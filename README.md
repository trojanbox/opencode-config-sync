# opencode-config-sync

OpenCode V2 全局配置同步插件。使用一个 Git 仓库在多台电脑之间同步 `~/.config/opencode` 中的配置、Agent、Command、Skill、Tool 等内容。

当前版本：`0.1.0`（首个可测试版本）。

## 设计目标

- 使用现有 Git SSH / Credential Manager，不在插件里保存 GitHub Token。
- 默认手动同步，首次测试不会静默覆盖本地配置。
- 基于本机上一次成功同步状态做文件级三方合并。
- 同一个文件在两台机器都修改时停止同步并报告冲突。
- `git push` 永远不使用 force；远端在同步过程中被其他机器更新时，本次推送会失败并要求重新同步。
- 推送前扫描明显的明文 Token / API Key / Password / Private Key。
- 同步白名单之外的 OpenCode 数据不会被读取或删除。
- 符号链接默认拒绝，避免把配置目录外的内容意外同步出去。

## 当前兼容范围

面向 OpenCode 2.x / V2 Plugin API：

```jsonc
{
  "plugins": [
    {
      "package": "./vendor/opencode-config-sync",
      "options": {}
    }
  ]
}
```

插件入口直接导出 `{ id, setup }`，运行时不依赖 `@opencode/plugin  包，因此本地插件加载时不会额外依赖 Plugin SDK 的模块解析。

OpenCode 1.x 暂未作为本版本的兼容目标。

## 1. 准备两个仓库

这个仓库只放插件源码：

```text
https://github.com/trojanbox/opencode-config-sync
```

另外创建一个 **Private Git 仓库** 保存你的个人 OpenCode 配置，例如：

```text
git@github.com:trojanbox/opencode-config-data.git
```

强烈建议配置仓库保持私有。即使插件有明文凭据扫描，也不能把它当作完整的 Secret 管理方案。

## 2. 安装插件进行测试

建议把源码固定克隆到 OpenCode 全局配置目录下的 `vendor/`。这个目录不会被插件默认同步，也不会被 OpenCode 自动扫描成插件：

```bash
mkdir -p ~/.config/opencode/vendor
git clone https://github.com/trojanbox/opencode-config-sync \
  ~/.config/opencode/vendor/opencode-config-sync
```

编辑全局配置：

```text
~/.config/opencode/opencode.jsonc
```

加入：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./vendor/opencode-config-sync",
      "options": {
        "repository": "git@github.com:trojanbox/opencode-config-data.git",
        "branch": "main"
      }
    }
  ]
}
```

`./vendor/opencode-config-sync` 相对于这份 `opencode.jsonc` 解析，所以不同电脑可以保持同一个配置值。

插件调用系统 `git`，请确保：

```bash
git --version
```

并且这台电脑已经能访问配置仓库：

```bash
git ls-remote git@github.com:trojanbox/opencode-config-data.git
```

## 3. 第一次测试

启动 OpenCode 后，先让 Agent 调用：

```text
请调用 config_sync，action=status
```

如果能看到类似：

```json
{
  "action": "status",
  "configured": true,
  "state": "local-ahead"
}
```

说明插件已加载。

第一台电脑把现有配置发布到私有配置仓库：

```text
请调用 config_sync，action=push
```

第二台电脑安装插件后：

```text
请调用 config_sync，action=pull
```

后续正常使用推荐：

```text
请调用 config_sync，action=sync
```

## 同步动作

### `status`

只读取状态并 fetch 远端，不修改配置：

```json
{
  "action": "status"
}
```

状态可能是：

| 状态 | 含义 |
| --- | --- |
| `synced` | 本地与远端都没有相对上次同步的变化 |
| `local-ahead` | 只有本地发生变化 |
| `remote-ahead` | 只有远端发生变化 |
| `diverged` | 两边都有变化，但修改的是不同文件或结果可安全合并 |
| `conflict` | 同一个文件在两边产生了不同内容 |
| `unconfigured` | 没有配置同步仓库 |

### `sync`

执行安全三方合并：

```json
{
  "action": "sync"
}
```

无冲突时把合并结果写回本地和远端。

`sync` 不接受强制冲突方向。

### `pull`

拉取远端变化，同时保留没有冲突的本地变化：

```json
{
  "action": "pull"
}
```

遇到同文件冲突时默认停止。

明确需要远端覆盖冲突文件时：

```json
{
  "action": "pull",
  "force": true
}
```

此时只有冲突文件采用远端版本；本地独有且不冲突的变化仍会保留。

### `push`

发布本地变化，并吸收远端不冲突的变化：

```json
{
  "action": "push"
}
```

明确需要本地覆盖冲突文件时：

```json
{
  "action": "push",
  "force": true
}
```

插件不会执行 `git push --force`。这里的 `force` 只表示文件级冲突选择本地版本；最终 Git push 仍要求 fast-forward。

## 默认同步内容

默认白名单：

```text
opencode.json
opencode.jsonc
cli.json
AGENTS.md
agents/
commands/
skills/
tools/
themes/
package.json
bun.lock
bun.lockb
```

`plugins/` 默认没有放进白名单。OpenCode 的 npm 插件声明已经在 `opencode.json(c)` 中同步；把本地插件源码也同步会增加自举、依赖目录和递归修改风险。

确实需要同步自己的本地插件源码时，可以显式加入：

```jsonc
{
  "plugins": [
    {
      "package": "./vendor/opencode-config-sync",
      "options": {
        "repository": "git@github.com:trojanbox/opencode-config-data.git",
        "include": [
          "opencode.jsonc",
          "AGENTS.md",
          "agents",
          "commands",
          "skills",
          "tools",
          "themes",
          "plugins"
        ]
      }
    }
  ]
}
```

`include` 当前使用明确的文件/目录路径，不使用 glob。父路径和子路径不能同时出现。

## Secret 防护

下面这种配置会在 push/sync 前被阻止：

```jsonc
{
  "provider": {
    "openai": {
      "apiKey": "sk-real-secret"
    }
  }
}
```

推荐使用 OpenCode 自己的环境变量 / 文件引用：

```jsonc
{
  "provider": {
    "openai": {
      "apiKey": "{env:OPENAI_API_KEY}"
    }
  }
}
```

默认会识别：

- API key / token / secret / password
- Authorization
- client secret / access token / refresh token
- PEM private key
- URL 中的 `user:password@host`

如确实需要同步包含这类字面量的文件，可以设置：

```json
{
  "allowUnsafeSecrets": true
}
```

这个开关风险很高，建议只用于明确知道内容安全的测试仓库。

## 自动同步

第一轮测试建议保持默认：

```json
{
  "startupMode": "off",
  "intervalSeconds": 0
}
```

确认手动同步稳定后，可以使用：

```jsonc
{
  "plugins": [
    {
      "package": "./vendor/opencode-config-sync",
      "options": {
        "repository": "git@github.com:trojanbox/opencode-config-data.git",
        "startupMode": "pull",
        "intervalSeconds": 300
      }
    }
  ]
}
```

- `startupMode: "pull"`：插件启动后尝试拉取。
- `startupMode: "sync"`：插件启动后尝试双向同步。
- `intervalSeconds`：`0` 关闭；启用时最小 60 秒，定时执行安全 `sync`。
- 自动任务遇到冲突只记录错误，不会强制选择任何一边。

## 完整 Options

| Option | 默认值 | 说明 |
| --- | --- | --- |
| `repository` | 无 | Git 远端；也可用 `OPENCODE_CONFIG_SYNC_REPOSITORY` |
| `branch` | `main` | 同步分支 |
| `configDir` | OpenCode 全局配置目录 | 通常无需设置 |
| `stateDir` | XDG state / LocalAppDaTa | 内部 clone 和三方合并基线 |
| `remoteDirectory` | `.opencode-config-sync/config` | 配置仓库中由插件管理的目录 |
| `include` | 默认白名单 | 同步的文件/目录 |
| `machineId` | hostname | Git commit 中标记来源机器 |
| `startupMode` | `off` | `off` / `pull` / `sync` |
| `intervalSeconds` | `0` | 自动同步周期，最小 60 秒 |
| `maxFileSizeBytes` | 5 MiB | 单文件上限 |
| `maxTotalBytes` | 50 MiB | 一次同步内容总上限 |
| `maxFiles` | 5000 | 同步文件数量上限 |
| `allowUnsafeSecrets` | `false` | 是否允许推送 Secret 扫描命中项 |
| `gitTimeoutMs` | 60000 | 单个 Git 命令超时 |

## 环境变量

当前支持：

```text
OPENCODE_CONFIG_SYNC_REPOSITORY
OPENCODE_CONFIG_SYNC_BRANCH
OPENCODE_CONFIG_SYNC_MACHINE_ID
OPENCODE_CONFIG_SYNC_STATE_DIR
OPENCODE_CONFIG_DIR
XDG_CONFIG_HOME
XDG_STATE_HOME
```

## 远端仓库布局

插件只管理配置仓库中的：

```text
.opencode-config-sync/
└── config/
    ├── opencode.jsonc
    ├── AGENTS.md
    ├── agents/
    ├── commands/
    ├── skills/
    └── ...
```

Git 历史本身就是同步历史。每次真正发生远端变化时，插件会创建：

```text
sync: <machine-id> <timestamp>
```

形式的 commit。

## 本地状态

三方合并基线保存在本机 state 目录，不进入配置仓库。

Linux/macOS 默认类似：

```text
~/.local/state/opencode-config-sync/
```

内部包含：

```text
repos/   # 插件自己的 Git checkout
state/   # 上一次成功同步的文件 hash 基线
tmp/     # 同步期间的临时合并目录
```

插件不会把用户正在工作的 Git checkout 当内部同步 checkout 使用。

## 开发与测试

当前测试不需要网络，也不需要 OpenCode SDK；需要 Node.js 22.18+（该版本起原生 TypeScript type stripping 默认启用）：

```bash
npm test
```

覆盖：

1. 空仓库首次 push + 第二台机器 pull。
2. 两台机器修改同一文件时报告冲突。
3. 两台机器修改不同文件时自动合并。
4. 明文 API Key 在首次 push 前被阻止。

当前测试结果基于 Node.js 22.18+ 的原生 TypeScript type stripping + 本地 bare Git repository。

## 已知边界

- 当前按**整个文件**判断冲突，不做行级文本 merge。
- 当前没有图形界面。
- 当前未发布到 npm，新电脑仍需先把这个插件 clone 到固定路径。
- OpenCode 1.x 兼容尚未实现。
- Secret 扫描是安全护栏，无法取代专用 Secret 管理工具。
- 同步内容中的 symlink 会被拒绝。
