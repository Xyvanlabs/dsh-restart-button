# dsh-restart-button

给 [DeepSeek Harness](https://github.com/deepseek-ai)（下称 DSH）桌面端加一颗 **重启** 按钮：位置在**侧边栏底栏、设置齿轮左边**，点一下 = **强制关闭 Harness 的全部进程，然后用同一个可执行文件重新打开**。

![按钮在侧边栏底栏](docs/sidebar-footer.png)

给插件 / Host 侧的改动做「立即生效」用，省得自己去任务管理器里杀进程。

> 想先知道「为什么这么做、坑在哪」，看 [docs/DESIGN.md](docs/DESIGN.md)。本文只讲装、用、排查。

## 它解决什么问题

DSH 的插件分两层，热更新能力不一样：**Web 半**改完刷新页面就生效，**Host 半**（服务端插件、路由、工具、profile 配置）改完必须让应用进程重启一次才加载。

没有这颗按钮时，这个「重启一次」只能手工做，而且容易做不干净：Harness 是 Electron 应用，主进程下面挂着 host 子进程和若干渲染进程，从任务栏关掉主窗口时偶尔会留下孤儿进程，下次启动就变成两个实例抢同一个端口——表现是「打不开」或「打开还是旧的」。

原生界面也没有等价入口：标题栏只有最小化/最大化/关闭，渲染进程的 `preload` 只提供协议版本、设备信息、快捷键这类只读接口，**没有重启通道**。所以只能由插件自己动手。

## 为什么是这个实现

三件事决定了写法，都是实测出来的：

- **干活的不能是应用自己**：应用一退出，它派生的子进程会被一起收走；Host 自我 respawn 又会和桌面壳的监管打架。所以由一个用 **WMI**（`Win32_Process.Create`）创建的独立 PowerShell helper 执行重启——父进程是 `WmiPrvSE.exe`，应用退出后它照样活着，且仍在交互式会话里。
- **创建 helper 必须带 `ShowWindow = 0`**：helper 是控制台程序，不带这个参数 Windows 会给它新分配一个终端窗口，重启完就一直留在屏幕上。launcher 自己的 `-WindowStyle Hidden` 管不到它。
- **重开应用也必须走 WMI**：用 `Start-Process` 拉起的应用会继承 helper 的控制台，用户一关那个终端，应用收到 `CTRL_CLOSE_EVENT` 跟着退出——这就是「关掉终端 Harness 也没了」。

细节、以及实测过但不能用的替代写法，都在 [docs/DESIGN.md](docs/DESIGN.md)。

## 安装

```powershell
& 'D:\DeepSeek\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add link:'D:\DeepSeek space\ChaJian\dsh-restart-button'
```

装完后**关闭并重新打开**一次 DeepSeek Harness（Host 侧插件需要重启才加载），侧边栏底栏就会出现「重启」。

之后每次改动 `lib/index.js` 也要重开一次应用才会加载新代码（可用 `GET /restart-button/status` 返回的 `version` 确认）。
只改 `lib/client.js`（UI 半）时不用重开：刷新页面即可。

## 卸载

```powershell
& 'D:\DeepSeek\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove dsh-restart-button
```

## 点一下会发生什么

1. 按钮先显示「重启中…」，向 Host 发 `POST /restart-button/restart`；
2. Host 先写 helper 脚本，再用一个极短的 PowerShell launcher 通过 **WMI** 把 helper 创建出来：
   WmiPrvSE 是它的父进程，所以应用退出后 helper 仍然存活，且仍运行在交互式会话里（已实测 session 一致、环境变量是当前用户的）；
3. helper 立即写下第一行日志（Host 会等这一行出现，最多 3 秒；没等到就说明 helper 没起来，按钮会显示失败原因）；
4. helper 先尝试 WM_CLOSE 让应用自己退出；**若 12 秒内没退出（例如正有任务在跑、弹了确认框没人点），直接 `taskkill /F /T` 杀掉整个进程树**——这对应「强制关闭」的语义；
5. 进程全部退出后，用同一个可执行文件重新启动应用（同样走 WMI，不继承控制台）；
6. 页面通常先白屏再自动恢复；若 45 秒还没断开，按钮会自行复原并提示「重启超时」，不会卡在「重启中…」。

### 为什么整个过程不弹终端窗口

helper 是 `powershell.exe`（控制台程序），只要用 `Win32_Process.Create` 创建它，Windows 就会**新分配一个终端窗口**——
launcher 自己的 `-WindowStyle Hidden` 只影响它自己的窗口，管不到这个新进程。所以 launcher 创建 helper 时必须带启动参数：

```powershell
$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow = [uint16]0          # SW_HIDE：窗口存在但不可见
([wmiclass]'Win32_Process').Create($inner, $null, $startup)
```

实测过、但**不能**用的写法：`CreateFlags = 0x8`（DETACHED_PROCESS，进程能起来但脚本一行都不执行）、
`CreateFlags = 0x08000000`（CREATE_NO_WINDOW，返回 21 无效参数）、
`Invoke-CimMethod ... -Arguments @{ ProcessStartupInformation = $si }`（抛「无法从提供的 .NET 对象推断 CimType」）。
只有「同步调用 `[wmiclass]'Win32_Process'.Create($cmd, $cwd, $startup)` + `ShowWindow = 0`」这一种组合同时满足「不弹窗」和「脚本照常执行」。

### 为什么关掉终端不会连带关掉 Harness

原来第 5 步用 `Start-Process` 拉起应用，新应用会**继承 helper 的控制台**（`AttachConsole` 返回成功），
于是用户一关那个终端窗口，应用会收到 `CTRL_CLOSE_EVENT` 一起退出——这正是「关终端把 Harness 也关了」的原因。
现在应用也改用 **WMI 创建**：父进程是 WmiPrvSE，不带任何控制台继承（实测应用进程 `AttachConsole` 失败 = 没有控制台），
helper 退出 / 终端消失都不再影响它。`Start-Process` 只作为 WMI 失败时的兜底保留。

> 为什么不直接 `spawn(..., { detached: true })`：在本机上这种 detached 子进程会「拿到 pid 但立刻以 0 退出、脚本一行都不执行」，
> 表现就是「点了没反应」且日志目录里只有 `.ps1`、没有 `.log`。WMI 创建是目前验证过能跨父进程退出继续跑的路径。

日志（helper 每步都有记录）：`%TEMP%\dsh-restart-button\restart-*.log`；
启动器结果：`%TEMP%\dsh-restart-button\launch-*.json`（`{ ok, mode, pid, returnValue, error }`）。

### 自检

```bash
curl -s http://127.0.0.1:<GUI 端口>/restart-button/status
# {"ok":true,"version":"wmi-2","desktop":true,"executable":"DeepSeek Harness.exe","appPid":44540}
```

`version` 不是 `wmi-2` 说明运行中的 Host 还是旧代码，重开一次应用即可。

## 排查

| 现象 | 看哪里 | 说明 |
| --- | --- | --- |
| 底栏没有这个按钮 | 浏览器控制台 | `apply` 里 `slots.inject('sidebar.footer.action')` 没有落地；确认本版 DSH 的侧边栏声明了该 slot |
| 点了没反应、按钮不变 | 按钮 tooltip（悬停显示失败原因） | POST 失败或 helper 没起来，tooltip 里带后端返回的原因 |
| 日志目录只有 `.ps1` 没有 `.log` | `launch-*.json` 的 `error` | WMI 创建失败（被安全软件拦、或 WMI 服务异常） |
| 重启时弹出终端窗口 | `launch-*.json` 的 `mode` | 只有 `wmi-2` 起才带 `ShowWindow=0`；`/status` 的 `version` 还是 `wmi-1` 说明 Host 没重载 |
| 关掉那个终端后 Harness 也没了 | `restart-*.log` 里 `started new pid … (wmi)` / `(start-process)` | 出现 `(start-process)` 说明 WMI 启动失败走了兜底，此时应用会继承 helper 的控制台 |
| `status` 里没有 `version` 字段 | `GET /restart-button/status` | 运行中的 Host 还是旧代码，需要重开应用一次 |
| 提示「不是桌面版」 | 按钮 tooltip | 在浏览器里跑纯 Web Host 时无 `process.versions.electron`，路由回 409 |

## 位置与样式

- 落在 `sidebar.footer.action`（list slot，`order: 10`），即设置齿轮紧左边；
- 高度/内边距/字体逐条对齐 DSH 原生的设置按钮（42px 高、`padding: 0 10px 0 8px`、`gap: 8px`、14px/22px），
  hover 用同一套 `--dsw-alias-interactive-bg-hover`，看起来像底栏原生的一项而不是外挂件；
- **宽度按内容自适应，不占满整行**（`flex:0 0 auto; width:auto; max-width:100%`）。
  宿主原本把动作区当成一整行（`.footerActions{width:100%}`），但其他插件可能把它改成横向排列
  ——例如 `balance-dsh` 用 `:has()` 把 `footArea` 改成 `row`、`footerActions` 改成 `justify-content:flex-end`、
  设置齿轮 `order:-1` 挪到最左。此时若本按钮仍写 `width:100%; flex:none`，它会独占整行、把余额胶囊挤出可视区。
  改为内容宽度后两者天然并排；空间不足时 `max-width:100%` + `overflow:hidden` 负责裁切而不是溢出容器，
  图标 `flex:none` 永远不缩，文字用 `text-overflow:ellipsis` 兜底；
- 侧边栏收起成 56px 窄条时，DSH 会把整个底栏 `display:none`，因此该按钮随之隐藏（原生设置按钮也一样），这是预期行为。

### 文案

这一项在三个地方出现，三处都只有「重启」两个字（英文 `Restart`）：

| 位置 | 取自 | 说明 |
| --- | --- | --- |
| 底栏行内文字 | `DICTIONARIES.zh.label` | `.row__label` 里的可见文字 |
| 悬停提示 | 同一个 `label` | 平时就是「重启」，只有重启失败时临时追加 ` — <原因>`，8 秒后自动复原 |
| 无障碍名称 | 恒为 `label` | `aria-label` 不带任何附加文字，任何状态下都只有「重启」 |
| 主题（如 `dsh-claude-style`）的账户弹层 | 读 `aria-label` | 该主题把底栏插件项镜像进弹层时优先用 `aria-label`，所以无障碍名称不能写长句，否则弹层会显示整句说明 |

## 结构

```
dsh-restart-button/
  package.json        # dsh.bundle.patch + dsh.client(platform=web)
  cordis.patch.yml    # 把 restart-button 这一行插入 profile
  icon.svg            # 插件市场列表图标
  lib/index.js        # Host 半：注册 POST /restart-button/restart（仅 loopback），WMI 启动 helper
  lib/client.js       # 浏览器半：底栏按钮（__ModuleLoader__ 包装 + slots.register）
  docs/DESIGN.md      # 设计说明：为什么这么做、踩过哪些坑、边界与限制
```

Host 路由还提供 `GET /restart-button/status`，返回 `{ ok, version, desktop, executable, appPid }`，可用于自检。

## 限制

- 只支持 **Windows 桌面版**：helper 是 PowerShell + WMI，Linux/macOS 没有等价实现。
- 只允许**回环来源**：`isLoopback()` 比对 `req.socket.remoteAddress`，远端会话一律 403。
- 没有 CSRF token：依赖回环限制 + `POST` 方法，这一层没有更强的鉴权可用。
- 重启前不保存草稿、不恢复页面状态（页面本来就随应用重启而重载）。

## License

MIT
