# dsh-restart-button 设计说明

> 这份文档回答四个问题：它是什么、为什么要做、解决了什么问题、怎么用。
> 面向两类读者：想知道「装不装」的使用者，和想知道「为什么这么写」的开发者。
> 安装与排查的操作型内容在 [README](../README.md)，本文只讲判断依据。

## 1. 它是什么

一颗按钮，位置在 DeepSeek Harness（下称 DSH）桌面端**侧边栏底栏、设置齿轮左边**（`sidebar.footer.action` 插槽，`order: 10`）。点一下 = **强制关闭 Harness 的全部进程，然后用同一个可执行文件重新打开**。

![按钮在侧边栏底栏](sidebar-footer.png)

它由两半组成，各自负责一件事：

| 半 | 文件 | 职责 | 生效方式 |
| --- | --- | --- | --- |
| Host 半 | `lib/index.js` | 注册 `POST /restart-button/restart`（仅回环地址），用 WMI 拉起一个 PowerShell helper 完成「关进程 → 重开」 | 改完要重开应用 |
| Web 半 | `lib/client.js` | 在侧边栏底栏渲染「重启」行，点击后 `fetch` 上面的路由 | 改完刷新页面即可 |

两半都**不加任何依赖**：Host 半只用 `node:child_process` / `node:fs` / `node:path` / `node:os`，Web 半只用 `__ModuleLoader__` 提供的 `react` 与 `react/jsx-runtime`。

## 2. 为什么要做

DSH 的插件分两层，两层的热更新能力不一样：

- **Web 半（客户端）** 改完刷新页面就生效，改一次看一次，很快。
- **Host 半（服务端插件、路由、工具、profile 配置）** 是进程启动时加载的，改完**必须让应用进程重启一次**才生效。

没有这颗按钮时，这个「重启一次」只能手工做：找窗口、关窗口、等它退、再从开始菜单点回来。更麻烦的是**关不干净**——Harness 是 Electron 应用，主进程下面挂着 host 子进程和若干渲染进程，从任务栏关掉主窗口时偶尔会留下孤儿进程，下次启动就变成两个实例抢同一个端口，表现是「打不开」或「打开是旧的」。

原生界面也没有对应的入口：标题栏只有最小化/最大化/关闭，侧边栏底栏只有设置齿轮，`app.quit()` 这类能力**没有暴露给 Web 层**（渲染进程的 `preload` 只提供协议版本、设备信息、快捷键等只读接口，没有重启通道）。所以想「在界面里点一下重启」，只能由插件自己动手。

**目的**：把「改 Host 侧代码 → 重启 → 验证」这个循环里唯一的手工步骤去掉，让一次迭代从「十几秒 + 一次找窗口」变成「一下点击」。

## 3. 解决了什么问题

### 3.1 关不干净：孤儿进程

只关主窗口不够。helper 会先发 `WM_CLOSE` 让应用自己走正常退出流程（`window-all-closed` → `app.quit()` → Host 优雅关闭）；**12 秒内没退出**（例如正有任务在跑、或弹了确认框没人点）就直接 `taskkill /F /T` 杀掉整个进程树。这对应按钮文案里的「强制关闭」。

常量和它的含义（`lib/index.js:26-32`）：

| 常量 | 值 | 作用 |
| --- | --- | --- |
| `VERSION` | `wmi-2` | 自检用：`/status` 返回它，用来确认 Host 加载的是哪版 |
| `GRACE_SECONDS` | 12 | 优雅关闭的等待上限，超时才强杀 |
| `HELPER_BOOT_TIMEOUT_MS` | 3000 | 等 helper 写下第一行日志，等不到就判定启动失败 |
| `LAUNCHER_TIMEOUT_MS` | 20000 | 同步 launcher 的上限（CIM 调用 + wmic 兜底） |

### 3.2 helper 必须活得比应用久

重启的执行者不能是应用自己：应用一退出，它派生的子进程会被一起收走；而 Host 侧自我 respawn 又会和桌面壳的监管机制打架（`dsh-market` 明确拒绝在桌面管理的 profile 下这么做）。

所以真正干活的是一个**独立的 PowerShell helper**，它由 WMI（`Win32_Process.Create`）创建：父进程是 `WmiPrvSE.exe` 而不是 Harness，因此应用退出后它照样活着，并且仍在**交互式会话**里（实测 session 一致，环境变量是当前用户的）。用 `spawn(..., { detached: true })` 在本机行不通——子进程拿到 pid 后立刻以 0 退出，脚本一行都不执行，表现是「点了没反应」。

### 3.3 全程不弹终端窗口（`wmi-2` 修的 bug）

helper 是 `powershell.exe`，控制台程序。**只要用 `Win32_Process.Create` 创建它，Windows 就会新分配一个终端窗口**——launcher 自己的 `-WindowStyle Hidden` 只管它自己，管不到这个新进程。第一版就是这么写的，结果是「重启之后屏幕上多出一个黑窗口，而且它不会自己关」。

修法是给创建调用带上启动参数：

```powershell
$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow = [uint16]0          # SW_HIDE：窗口存在但不可见
([wmiclass]'Win32_Process').Create($inner, $null, $startup)
```

实测过、但**不能**用的三种写法：

- `CreateFlags = 0x8`（`DETACHED_PROCESS`）——进程能起来，脚本一行都不执行；
- `CreateFlags = 0x08000000`（`CREATE_NO_WINDOW`）——`Create` 直接返回 21（无效参数）；
- `Invoke-CimMethod ... -Arguments @{ ProcessStartupInformation = $si }`——抛「无法从提供的 .NET 对象推断 CimType」。

只有「**同步调用** `[wmiclass]'Win32_Process'.Create($cmd, $cwd, $startup)` + `ShowWindow = 0`」这一种组合同时满足「不弹窗」和「脚本照常执行」。

### 3.4 关终端不会连带关掉 Harness（`wmi-2` 修的 bug）

第一版最后一步用 `Start-Process` 重新拉起应用。这个新应用会**继承 helper 的控制台句柄**，于是用户一关那个黑窗口，应用就收到 `CTRL_CLOSE_EVENT` 跟着退出——这正是「关掉终端，Harness 也没了」的原因。

现在应用也改由 **WMI 创建**：父进程是 `WmiPrvSE`，不带任何控制台继承（实测新进程 `AttachConsole` 失败 = 没有控制台），helper 退出或终端消失都不再影响它。`Start-Process` 只作为 WMI 失败时的兜底保留，日志里会写 `(wmi)` 还是 `(start-process)` 以便区分。

### 3.5 不跟别的插件抢侧边栏那行

按钮宽度按内容自适应（`flex:0 0 auto; width:auto; max-width:100%`），不占满整行。

宿主原本把动作区当一整行（`.footerActions{width:100%}`），但其他插件会改写这个布局：例如 `balance-dsh` 用 `:has()` 把 `footArea` 变成横排、`footerActions` 改成 `justify-content:flex-end`、并把设置齿轮 `order:-1` 挪到最左。此时若本按钮仍写 `width:100%; flex:none`，它会独占整行、把余额胶囊整个挤出可视区。

也不用 `flex:0 1 auto`（可收缩）：余额那行永远抢 `width:100%`，可收缩的项在**任何**宽度下文字都会被省略号截断，而它其实只在空间真不足时才该缩。`max-width:100%` 负责不溢出容器，`overflow:hidden` 负责裁切，图标 `flex:none` 永远不缩。

## 4. 基本用法

### 4.1 安装

DSH 桌面版（其它形态下 `desktopExecutable()` 返回 null，路由回 409）：

```powershell
& 'D:\DeepSeek\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add link:'D:\DeepSeek space\ChaJian\dsh-restart-button'
```

装完**关闭并重开一次**应用（Host 半需要重启才加载），底栏就会出现「重启」。之后只改 `lib/client.js` 时刷新页面即可，不必重开。

### 4.2 点一下会发生什么

1. 按钮变灰显示「重启中…」，向 Host 发 `POST /restart-button/restart`；
2. Host 写两个临时脚本，用同步 launcher 通过 WMI 创建 helper（`ShowWindow=0`，无窗口）；
3. helper 写下第一行日志，Host 最多等 3 秒确认它起来了，然后返回 `202`；
4. helper 先 `WM_CLOSE`；12 秒内没退出就 `taskkill /F /T` 杀进程树；
5. 用同一个可执行文件重新拉起应用（走 WMI，不继承控制台）；
6. 页面通常先白屏再自动恢复；如果 45 秒还没断开，按钮会自行复原并提示超时，不会卡在「重启中…」。

### 4.3 自检

```bash
curl -s http://127.0.0.1:<GUI 端口>/restart-button/status
# {"ok":true,"version":"wmi-2","desktop":true,"executable":"DeepSeek Harness.exe","appPid":44540}
```

`version` 不是 `wmi-2` 说明运行中的 Host 还是旧代码，重开一次应用即可。

### 4.4 失败时看哪里

- **按钮悬停提示**：平时是「重启」，失败时临时追加 ` — <原因>`，8 秒后复原；无障碍名称恒为「重启」，避免主题把整句说明镜像进菜单。
- **`%TEMP%\dsh-restart-button\restart-*.log`**：helper 每步一行，例如一次真实重启的记录：

```
2026-10-21T21:59:12 helper started pid=29348 session=1
2026-10-21T21:59:14 target app pid 49552 exe D:\DeepSeek\DeepSeek Harness.exe
2026-10-21T21:59:14 asking the main window to close (WM_CLOSE)
2026-10-21T21:59:26 graceful close timed out; killing the app process tree
2026-10-21T21:59:29 starting D:\DeepSeek\DeepSeek Harness.exe
2026-10-21T21:59:29 started new pid 44540 (wmi)
2026-10-21T21:59:34 helper finished
```

- **`%TEMP%\dsh-restart-button\launch-*.json`**：`{ ok, mode, pid, returnValue, error }`。`mode` 为 `wmi-cim` 表示走了主路径，`wmi-wmic` 是兜底，出现 `(start-process)` 则说明应用是被 `Start-Process` 拉起的（会继承控制台，关终端仍会连坐）。

## 5. 边界与已知限制

- **只支持桌面版**。浏览器里跑纯 Web Host 时无 `process.versions.electron`，路由返回 409，按钮会显示失败原因。
- **只允许回环来源**。`isLoopback()`（`lib/index.js:35-38`）比对 `req.socket.remoteAddress`，远端会话一律 403——重启是高权限操作，不该被局域网里任意页面触发。
- **没有 CSRF token**。依赖回环限制 + `POST` 方法；桌面文档代理本身就是回环，这一层没有更强的鉴权可用。
- **收起成 56px 窄条时按钮消失**：DSH 会把整个底栏 `display:none`，原生设置齿轮也一样，属预期行为。
- **`GRACE_SECONDS = 12` 是体验取舍**：调大更「温柔」但用户要多等；调小则有正在跑的任务更容易被强杀。
- **未做**：重启前保存草稿、重启后恢复页面状态（页面本来就随应用重启而重载）、Linux/macOS 的等价实现（helper 目前是 Windows PowerShell 专用）。

## 6. 结构

```
dsh-restart-button/
  package.json        # dsh.bundle.patch + dsh.client(platform=web)
  cordis.patch.yml    # 把 restart-button 这一行插入 profile
  icon.svg            # 插件市场列表图标
  lib/index.js        # Host 半：路由 + 写脚本 + WMI 拉起 helper
  lib/client.js       # Web 半：底栏按钮（__ModuleLoader__ 包装 + slots.register）
  docs/DESIGN.md      # 本文
  docs/sidebar-footer.png
```

`lib/index.js` 的调用链：`handle()` → `spawnRestartHelper()` → 生成 `restart-*.ps1`（`helperScript`）与 `launch-*.ps1`（`launchScript`）→ `spawnSync('powershell.exe', … -File launch-*.ps1)` → `readLaunchResult()` → `waitForHelperBoot()` → 返回 202。
