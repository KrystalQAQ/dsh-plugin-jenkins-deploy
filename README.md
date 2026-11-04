# dsh-plugin-jenkins-deploy（部署发布）

DSH Web 客户端插件：在左侧栏新增「部署发布」入口，通过 Jenkins 查看前后端项目并一键部署。

## 功能

- **左侧栏入口**：侧栏出现「部署发布」图标，点击打开主面板页面。
- **自动归类项目**：从 Jenkins `view/kunhua` 拉取 job 列表，按「环境（开发/测试/生产）× 类型（前端/后端）」自动分组。
- **参数感知部署**：自动读取每个 job 的参数定义；若存在 `build_branch`（或含 `branch` 的参数）则显示分支下拉（默认 dev，可选 master），否则直接触发。
- **生产二次确认**：`prod` 环境部署按钮为红色「部署到生产」，点击弹出二次确认框。
- **状态与日志**：显示最近一次构建的构建号/结果/时间（含构建中蓝色状态）；可查看构建控制台日志；构建中自动轮询刷新。
- **凭据安全**：Jenkins 地址/用户/Token 保存在服务端本地文件 `~/.dsh/jenkins-deploy.json`（权限 600），浏览器只与同源路由通信，**Token 永不下发前端**。

## 视觉设计

界面沿用 DSH 主题 token（`--dsw-alias-*` / `--dsw-radius-*` / `--dsw-shadow-*`），自动适配浅色/深色主题：

- 顶栏：品牌图标 + 标题/副标题，右侧分段式页签（项目 / 设置）。
- 项目分组：环境圆点（开发=蓝 / 测试=琥珀 / 生产=红）；卡片左侧彩色状态条（成功绿 / 失败红 / 构建中蓝 / 中止橙）。
- 卡片：等宽字体项目名 + 环境/类型药丸标签 + 构建状态；右侧分支下拉、日志、外链、部署按钮。
- 生产任务用红色「部署到生产」按钮，弱化误操作。

预览截图见 `preview/` 目录：

- `preview/jdp-light.png` / `preview/jdp-dark.png` — 项目列表（浅色/深色）
- `preview/jdp-settings.png` — 设置页
- `preview/jdp-confirm.png` — 生产确认弹窗

## 面向 agent 的工具

插件在 Host 侧通过 `ctx.tools.register` 注册三个**全局工具**（对所有 agent 可见）。它们与 UI 页面共用同一套凭据与 Jenkins 调用逻辑，符合 DSH「一个操作、两种调用方」原则。

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `jenkins_deploy_list` | 列出可部署项目（按环境/类型归类 + 最近构建状态） | `query?` 按 job 名过滤 |
| `jenkins_deploy_status` | 查询某 job 的最近构建与历史，可附控制台日志 | `job`(必填)、`build?`、`with_console?` |
| `jenkins_deploy_trigger` | 触发一次部署 | `job`(必填)、`branch?`(默认 dev)、`confirm_production?` |

设计要点：

- **生产安全**：`jenkins_deploy_trigger` 对 `prod` 环境，若未显式传 `confirm_production=true`，只返回 `{needs_confirmation:true}` 而**不真正触发**，促使模型先向用户二次确认。
- **结构化返回**：成功 `{ok:true,...}`，失败 `{ok:false,code,message}`（如 `not_configured` / `invalid_args` / `jenkins_error` / `network_error`），不抛异常、不回显 Token。
- **参数感知**：若 job 有 `build_branch` 参数则走 `buildWithParameters`，否则走 `build`。

## 架构

本包为「一包双端」的 DSH 插件：

- **Host 半边** `lib/index.js`：Cordis 插件，在 `ctx.webServer` 上注册 `/x-jenkins-deploy/*` 路由，代理调用 Jenkins REST API（含 CSRF crumb 处理），并读写本地凭据文件。
- **Client 半边** `lib/client.js`：浏览器端自注册模块（`window.__ModuleLoader__.load`），注册 `main` 主面板页面与 `sidebar.panellist` 左侧栏图标，仅用 React + 内联样式，无额外 UI 依赖。
- **`cordis.patch.yml`**：bundle 补丁，插入一行 `jenkins-deploy` 加载本包 Host 半边；Client 半边由 `package.json` 的 `dsh.client` 声明，由 client-modules 自动挂载。

### 主机路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/x-jenkins-deploy/config` | 读取/保存 Jenkins 配置（Token 留空表示沿用） |
| GET | `/x-jenkins-deploy/jobs` | 列出 job 并按环境/类型归类 |
| GET | `/x-jenkins-deploy/job/<job>/params` | 读取 job 参数定义 |
| POST | `/x-jenkins-deploy/build/<job>` | 触发构建，body: `{params:{build_branch:"dev"}}` |
| GET | `/x-jenkins-deploy/status/<job>` | 最近构建与历史（最近 10 次） |
| GET | `/x-jenkins-deploy/console/<job>/<build>` | 构建控制台日志（尾部 200KB） |

所有路由经 `ctx.connection.requestRejection` 浏览器信任栅栏，拒绝未认证/跨站请求。

## 安装

```bash
# 1) 把本仓库克隆到本地任意目录，然后链接安装到 web profile
git clone <本仓库地址> dsh-plugin-jenkins-deploy
dsh plugin --profile web add "link:$PWD/dsh-plugin-jenkins-deploy"

# 2) 重启当前 web 服务使其加载（重启会短暂断线，浏览器刷新即可）
#    Ctrl+C 当前 dsh web 进程后重新执行：
dsh web --host <你的地址> --port 3080 --no-open
```

> 说明：本包通过 `link:` 方式安装时，本地 `node_modules/@deepseek-ai/{dsh-tools,cordis,schemastery}`
> 需软链到 DSH 安装目录中的同名包，以便 Host 半边（`defineTool`）能解析依赖。可执行：
>
> ```bash
> DSH_NM="$(dirname "$(which dsh)")/../lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"
> mkdir -p node_modules/@deepseek-ai
> for p in dsh-tools schemastery cordis; do ln -sfn "$DSH_NM/$p" "node_modules/@deepseek-ai/$p"; done
> ```

首次打开后进入「设置」填写：

- Jenkins 地址：`http://<你的 Jenkins 地址>`
- 用户名：Jenkins 用户名
- API Token：对应用户的 Jenkins API Token

保存后切回「项目」即可看到项目列表。

## 文件

- `package.json` — 包声明（含 `dsh.bundle.patch` 与 `dsh.client`）
- `cordis.patch.yml` — bundle 补丁
- `lib/index.js` — Host 半边
- `lib/client.js` — Client 半边
