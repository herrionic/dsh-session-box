# @sessionbox/dsh-plugin

[English](README.en.md) | **中文**

把 [DeepSeek Harness](https://github.com/deepseek-ai) 的会话跑在 [SessionBox](https://github.com/Herry-too/session-box) 容器里。

一个会话一个执行环境：把会话绑定到容器后，它的文件、命令与搜索操作都在容器内进行，而 Harness 本身、会话存储以及其它会话仍然运行在宿主机上。切回宿主机后，该会话的行为与安装本插件之前完全一致。

- **按会话隔离，不是按进程。** 两个会话可以同时跑在两个不同容器里，第三个仍然留在宿主机。
- **绑定是插件状态，绝不写进会话日志。** 它存在 storage domain（`~/.dsh/storages/sessionbox.json`），因此没有安装本插件的 Harness 依然能正常读取会话日志。
- **宿主机保持原样。** 宿主机的文件系统、shell 与子进程提供者被载入隔离 realm，路由提供者只是转发，所以宿主会话的行为没有任何改变。
- **不静默回退。** 目标解析失败会明确报错，而不是悄悄把会话放到用户没有选择的地方执行。

## 目录

- [环境要求](#环境要求)
- [安装](#安装)
- [配置](#配置)
- [使用](#使用)
- [工作原理](#工作原理)
- [路径映射](#路径映射)
- [哪些东西仍在宿主机上](#哪些东西仍在宿主机上)
- [安全说明](#安全说明)
- [已知限制](#已知限制)
- [故障排查](#故障排查)
- [开发](#开发)
- [许可证](#许可证)

## 环境要求

- **DeepSeek Harness** `0.2.0-rc.2`。本插件声明的所有 Harness 包都已发布到 npm，因此安装与构建都不需要 Harness 源码仓库。
- **Node.js** `^22.19` 或 `>=24`。
- 一个可访问的 **SessionBox 服务端**，以及对应的 API token。
- 带 `bash` 的 Linux 容器镜像。镜像缺少 `ripgrep` 时会用 `apt` 安装一次（`provisionRipgrep`）。

## 安装

本插件就是一个普通的 DeepSeek Harness 插件包：由 Harness profile 在配置行里声明，并由 profile 提供该包。

1. 让 profile 能找到这个包。在它发布到 npm 之前，用本地路径或 git 依赖写进 profile 的 `package.json`：

   ```json
   {
     "dependencies": {
       "@sessionbox/dsh-plugin": "link:/绝对路径/dsh-session-box"
     }
   }
   ```

2. 在 profile 的 `cordis.patch.yml` 里加上配置行：

   ```yaml
   - id: sessionbox
     name: "@sessionbox/dsh-plugin"
     config:
       baseUrl: http://127.0.0.1:8787
       tokenRef: SESSIONBOX_TOKEN
   ```

3. 重启 Harness。

**必须在启动前启用。** 本插件会替换宿主机的 `fs`、`shell`、`subprocess` 三行；在运行中启用会触发 Harness 重新组装，而会话控制器会拒绝这种重组（`file-upload: Agent resolver is already registered`）。请在配置里启用后，带着它一起启动 Harness。

## 配置

所有配置都可以在界面里改：**设置 → SessionBox**。token 本身不会写进配置文件，而是按配置的凭据名存入凭据库。

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8787` | SessionBox 服务端地址。 |
| `tokenRef` | `SESSIONBOX_TOKEN` | 保存 API token 的凭据名。 |
| `containerRoot` | `/workspace` | 绑定容器内的工作目录。 |
| `defaultTarget` | `host` | 新建会话的起始环境：容器名/id，或 `host`。 |
| `defaultTimeoutMs` | `120000` | 容器操作的默认超时。 |
| `maxTimeoutMs` | `600000` | 调用方可以请求的超时上限。 |
| `requestTimeoutMs` | `30000` | 单次 agent 协议请求的期限。 |
| `maxOutputBytes` | `1048576` | 每条输出流保留的字节数。 |
| `provisionRipgrep` | `true` | 容器缺少 `ripgrep` 时自动安装。 |
| `containerPrograms` | `rg`、`ripgrep` | 这些程序的子进程会转发到容器内执行。 |

`defaultTarget` 在会话创建时生效。名字解析失败会**报错**，该会话仍然从宿主机启动；插件绝不会静默替换目标。

## 使用

执行环境是按会话选择的，就在输入栏上操作。

- **输入栏上的 chip**：显示当前会话的执行环境，并用于切换。它在挂载时、以及每次切换成功后重新读取容器列表。
- **命令**：效果相同，而且是唯一的写入路径：

  ```
  /sessionbox new-world     # 把当前会话绑定到该容器
  /sessionbox host          # 切回运行 Harness 的宿主机
  /sessionbox               # 报告当前环境与可用容器
  ```

切换立即生效：该会话的下一次工具调用就在新的环境里执行。模型也会被告知这次变化——既作为每次请求里的一条常驻说明，也作为对话记录里的一条一次性提示。

## 工作原理

一个会话的绑定就是插件自己存储里的一条记录。路由从内存同步读取它，所以任何工具调用都不需要等待存储。

```
会话 → 绑定 ─┬─ ctx.fs         → 容器文件系统 | 宿主机文件系统
             ├─ ctx.shell      → 容器内 bash  | 宿主机 shell
             └─ ctx.subprocess → 白名单程序   | 宿主机运行时
```

- **是路由提供者，不是替换。** 宿主机提供者被载入隔离 realm，路由器只是转发。宿主会话的行为没有任何改变。
- **按 agent 调整工具面。** 容器会话里 `pwsh` 被禁用（它是 Windows 宿主工具，而容器是 Linux），并自动补上 `bash`。切回宿主机时恢复原有工具面。
- **子进程走白名单。** `ctx.subprocess` 与宿主基础设施共用（git 探测、独立进程的子 agent 等），所以容器路由按程序逐个开启；默认覆盖 Harness 自带的 `ripgrep`，也就是 `glob` 与 `grep` 实际调用的那个。
- **每个会话一条记录。** 绑定之所以能在重启后保留，是因为它被持久化了；会话日志里只有给模型看的说明。

## 路径映射

绑定后的会话看到的是容器，而不是宿主机。

| 会话请求的路径 | 实际得到 |
| --- | --- |
| 相对路径 | 容器内 `containerRoot` 下的对应路径 |
| 绝对 POSIX 路径（如 `/etc/hostname`） | 容器内的该路径 |
| 宿主机工作区路径 | 容器内的 `containerRoot` —— 宿主侧的写法只是身份标识，并不是共享目录 |
| 其它宿主机路径 | 什么都没有：读取报"文件不存在"，写入被拒绝 |

最后一行是刻意的。那个宿主路径在容器里根本不存在，所以"文件不存在"是**如实**的回答；写入则直接拒绝，而不是悄悄落到用户并不想要的位置。

## 哪些东西仍在宿主机上

Harness 本身从不移动。会话、会话日志、投影、storage、凭据、界面、模型连接以及宿主侧的观察者，全部继续运行在宿主机上。被路由的只有上面列出的三个接缝。

## 安全说明

- API token 存在凭据库里，不在配置文件中。
- 绑定后的会话可以在容器内任意位置写入，受该会话自身的文件策略约束。容器内可写是刻意的：容器本身就是边界；容器内用户账户的权限不足会如实报错。
- 会话工作区之外的宿主路径，从绑定会话中不可达。
- 对于运行在宿主机上的会话，宿主文件沙箱没有任何改变。

## 已知限制

- **chip 没有推送式失效通知。** 浏览器半边无法订阅本插件自己的事件（转发事件白名单属于 Harness），所以 chip 在挂载时和每次切换后重新读取目录。在别处做的改动会在下次挂载时体现。
- **投影没有推送 API。** `executionTarget` 由会话日志派生，而 Harness 没有提供让它失效重算的接口，因此 chip 以插件自己的 Remote 目录为准，投影只作兜底。
- **切换提示是尽力而为。** 表面还没有受保护首面的会话暂时无法接收该提示，此时绑定照常生效、提示被跳过；每次请求里的常驻说明仍然会写明执行环境。
- **容器内不支持终端与 PTC。**
- **`readText` 超过 8 MiB** 会返回 `FS_TOO_LARGE`。
- **自动安装 `ripgrep` 需要容器镜像有网络与 `sudo`。**
- **回合外的路由按最长匹配路径前缀解析。** 新绑定在它自己的回合内立即生效；回合外的调用使用注册表当前视图。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 会话明明在容器里，chip 却显示 `host` | 把鼠标停在 chip 上：提示末尾是 `[id=... catalog=... listed=... projection=...]`。`listed=true` 表示宿主机已经报告了这条绑定。 |
| 选择器里没有容器 | 设置 → SessionBox：填好服务地址与 token，页面底部的容器列表就会显示。 |
| 插件没有激活 | 该配置行必须在启动前启用；运行中启用会被会话控制器拒绝。 |
| 容器里 `glob`、`grep` 失败 | 缺少 `ripgrep` 且安装失败。检查 `provisionRipgrep` 与容器的网络。 |
| 工具调用报权限不足 | 容器内该用户账户无权写入该路径。按 Linux 的常规做法在容器内提权（`sudo`）即可。 |

## 开发

本仓库是自洽的：`pnpm install` 除 `vendor/` 下随仓库携带的三个 `@sessionbox/*` 包（client、protocol、shared，本插件直接引用它们）之外，其余依赖全部来自 npm。

```sh
pnpm install
pnpm build       # esbuild 打包（dist/index.mjs）
pnpm typecheck
pnpm test        # 激活、路由与容器后端行为
pnpm probe       # 针对真实部署的只读容器能力探测
```

容器相关测试在没有凭据时会自动跳过；要运行它们，请在环境里设置 `SESSIONBOX_URL` 与 `SESSIONBOX_TOKEN`。

`client/index.js` 是浏览器半边。它是手写的——客户端模块注册表把该文件的字节直接送进页面，文件自己用 `window.__ModuleLoader__` 完成注册——所以不需要构建步骤。它自己挂载 Remote 命名空间（`ctx.remote.$mount`），因为客户端的命名空间列表固定在 `@deepseek-ai/dsh-api-remotes` 里。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
