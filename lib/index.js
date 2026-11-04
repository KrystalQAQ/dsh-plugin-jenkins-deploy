// 部署发布插件 —— Host 半边（在 Node 侧运行）
//
// 职责：
//   1. 在 webServer 上注册 /x-jenkins-deploy/* 路由，代理调用 Jenkins REST API。
//      浏览器只与同源路由通信，Jenkins 账号 / Token 绝不下发到前端。
//   2. 把 Jenkins 地址、用户、Token 持久化到本地 JSON 配置文件（~/.dsh/jenkins-deploy.json）。
//   3. 提供：读取/保存配置、列出可部署的 job（按前后端/环境归类）、读取 job 参数、
//      触发构建、查询构建状态、读取构建控制台日志、读取构建历史。
//
// Cordis 插件约定：导出 name / inject / apply（Config 可省略）。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { registerTools } from "./tool.js";

// ---------------------------------------------------------------------------
// 常量与基础工具
// ---------------------------------------------------------------------------

/** Cordis 插件名（Loader 行 id 与之对应）。 */
const name = "jenkins-deploy";

/** 本插件依赖的 Host 服务：webServer（注册 HTTP 路由）、connection（浏览器信任栅栏）。 */
const inject = ["webServer", "connection"];

/** 路由前缀（所有接口都挂在该前缀下）。 */
const ROUTE_PREFIX = "/x-jenkins-deploy";

/** 请求体大小上限，防止恶意大包（复用 open-in-app 的 64KB 口径）。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 调用 Jenkins 的超时时间（毫秒）。 */
const JENKINS_TIMEOUT_MS = 30 * 1000;

/**
 * 解析凭据配置文件路径。
 * @param {string} override - 配置里显式给出的路径，空字符串表示走默认。
 * @returns {string} 绝对路径。
 */
function resolveConfigPath(override) {
  if (typeof override === "string" && override.trim() !== "") return override;
  return join(homedir(), ".dsh", "jenkins-deploy.json");
}

/**
 * 发送 JSON 响应（统一 no-store，避免缓存配置/实时状态）。
 * @param {import('node:http').ServerResponse} res - HTTP 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} payload - 将被 JSON 序列化的负载。
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/**
 * 限制读取请求体大小并解析为 JSON 对象；超限或非对象返回 null。
 * @param {import('node:http').IncomingMessage} req - HTTP 请求对象。
 * @returns {Promise<object|null>} 解析后的对象或 null。
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks, size).toString("utf8");
  if (text.trim() === "") return {};
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 规范化 Jenkins 基础地址（去掉尾部斜杠）。
 * @param {string} url - 原始地址。
 * @returns {string} 规范化后的地址。
 */
function normalizeBaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// 凭据读写
// ---------------------------------------------------------------------------

/**
 * 读取凭据文件；不存在时返回空配置。
 * @param {string} filePath - 凭据文件绝对路径。
 * @returns {Promise<{url:string,user:string,token:string}>} 凭据（缺省为空串）。
 */
async function loadCredentials(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw);
    return {
      url: typeof data.url === "string" ? data.url : "",
      user: typeof data.user === "string" ? data.user : "",
      token: typeof data.token === "string" ? data.token : ""
    };
  } catch {
    return { url: "", user: "", token: "" };
  }
}

/**
 * 写入凭据文件（权限 600，含密钥）。
 * @param {string} filePath - 凭据文件绝对路径。
 * @param {{url:string,user:string,token:string}} creds - 待保存凭据。
 * @returns {Promise<void>} 写入完成。
 */
async function saveCredentials(filePath, creds) {
  await mkdir(dirname(filePath), { recursive: true });
  const payload = JSON.stringify(
    { url: normalizeBaseUrl(creds.url), user: creds.user, token: creds.token },
    null,
    2
  );
  await writeFile(filePath, payload, { encoding: "utf8", mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Jenkins API 客户端
// ---------------------------------------------------------------------------

/**
 * 构造 Basic 认证头。
 * @param {{user:string,token:string}} creds - 凭据。
 * @returns {string} Authorization 头值。
 */
function basicAuthHeader(creds) {
  const raw = `${creds.user}:${creds.token}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

/**
 * 调用 Jenkins REST API（附加 crumb 处理），返回解析后的 JSON 或文本。
 * @param {{url:string,user:string,token:string}} creds - 凭据。
 * @param {string} pathAndQuery - 以 / 开头的相对路径（含查询串）。
 * @param {object} [options] - 可选项：method、body(对象)。
 * @returns {Promise<{status:number, data:any}>} 状态码与解析结果。
 * @throws 当网络错误或超时时抛出。
 */
async function jenkinsRequest(creds, pathAndQuery, options = {}) {
  const base = normalizeBaseUrl(creds.url);
  if (base === "") throw new Error("尚未配置 Jenkins 地址");
  if (creds.user === "" || creds.token === "") throw new Error("尚未配置 Jenkins 账号或 Token");

  const method = options.method || "GET";
  const url = `${base}${pathAndQuery}`;
  const headers = {
    authorization: basicAuthHeader(creds),
    accept: "application/json"
  };

  // 写操作需要 Jenkins CSRF crumb，先取一次。
  let crumbHeader = {};
  if (method !== "GET" && method !== "HEAD") {
    try {
      const crumbRes = await fetch(`${base}/crumbIssuer/api/json`, {
        headers: { authorization: headers.authorization },
        signal: AbortSignal.timeout(JENKINS_TIMEOUT_MS)
      });
      if (crumbRes.ok) {
        const crumb = await crumbRes.json();
        if (crumb && crumb.crumbRequestField && crumb.crumb) {
          crumbHeader[crumb.crumbRequestField] = crumb.crumb;
        }
      }
    } catch {
      // crumb 获取失败不阻断，部分 Jenkins 允许无 crumb 写入。
    }
  }

  const init = {
    method,
    headers: { ...headers, ...crumbHeader },
    signal: AbortSignal.timeout(JENKINS_TIMEOUT_MS),
    redirect: "follow"
  };
  if (options.body !== undefined) {
    init.headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(options.body).toString();
  }

  const res = await fetch(url, init);
  const contentType = res.headers.get("content-type") || "";
  let data;
  if (contentType.includes("application/json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, data };
}

/**
 * 从 job 名推断所属分类与环境（用于前端分组显示）。
 * @param {string} jobName - Jenkins job 名，如 kh-wuliu-server-backend-dev。
 * @returns {{kind:string, kindLabel:string, env:string, envLabel:string, project:string}} 归类信息。
 */
function classifyJob(jobName) {
  const lower = jobName.toLowerCase();
  // 环境：dev / test / prod（含 master 归为 prod）
  let env = "other";
  let envLabel = "其他";
  if (/(^|-)prod($|-)/.test(lower) || /(^|-)online($|-)/.test(lower)) {
    env = "prod";
    envLabel = "生产";
  } else if (/(^|-)test($|-)/.test(lower) || /(^|-)staging($|-)/.test(lower)) {
    env = "test";
    envLabel = "测试";
  } else if (/(^|-)dev($|-)/.test(lower)) {
    env = "dev";
    envLabel = "开发";
  }

  // 前后端类型
  let kind = "other";
  let kindLabel = "其他";
  if (/(^|-)(frontend|web|ui)(-|$)/.test(lower)) {
    kind = "frontend";
    kindLabel = "前端";
  } else if (/(^|-)(backend|server|service|api)(-|$)/.test(lower)) {
    kind = "backend";
    kindLabel = "后端";
  }

  // 项目名：去掉尾部环境后缀，作为分组键与展示名。
  const project = jobName.replace(/-(dev|test|prod|online|staging)$/i, "");
  return { kind, kindLabel, env, envLabel, project };
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * 注册部署发布相关的全部 HTTP 路由。
 * @param {any} ctx - Cordis 上下文（带 webServer / connection）。
 * @param {any} config - 已解析的插件配置。
 */
function apply(ctx, config = {}) {
  const configPath = resolveConfigPath(config?.configPath);

  // 使用 connection 的浏览器信任栅栏，拒绝未认证/跨站请求。
  const connectionOf = () => Reflect.get(ctx, "connection");
  const rejected = (req, res) => {
    const connection = connectionOf();
    const rejection = connection?.requestRejection?.(req);
    if (rejection === void 0) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  /** 读取当前凭据（每次实时读取，保证 UI 保存后立即生效）。 */
  const creds = () => loadCredentials(configPath);

  // 注册面向 agent 的部署工具。tools 服务可能不存在（如纯 UI 组合），
  // 用 ctx.inject 在其可用时再注册，不阻塞插件其余部分。
  ctx.inject(["tools"], (tctx) => {
    registerTools(tctx, { creds: () => creds(), request: jenkinsRequest, classify: classifyJob });
  });

  /**
   * 统一的路由包装：处理信任栅栏、方法校验、异常与 JSON 响应。
   * @param {string} method - 允许的方法。
   * @param {(req:any,res:any)=>Promise<void>} handler - 业务处理。
   * @returns {(req:any,res:any)=>Promise<void>} 包装后的 handler。
   */
  const route = (method, handler) => async (req, res) => {
    if (rejected(req, res)) return;
    if (req.method !== method) {
      res.statusCode = 405;
      res.setHeader("allow", method);
      res.end();
      return;
    }
    try {
      await handler(req, res);
    } catch (error) {
      // 网络/超时/解析等异常统一以 502 返回，附可读信息（不含 token）。
      sendJson(res, 502, { error: String(error?.message || error) });
    }
  };

  // --- 1) 配置读写：GET 读取 / POST 保存（同一路由按方法分发，避免重复注册） ---
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: `${ROUTE_PREFIX}/config`,
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          try {
            if (req.method === "GET") {
              const c = await creds();
              sendJson(res, 200, { url: c.url, user: c.user, hasToken: c.token !== "" });
              return;
            }
            if (req.method === "POST") {
              const body = await readJsonBody(req);
              if (body === null) {
                sendJson(res, 400, { error: "请求体必须是 JSON 对象" });
                return;
              }
              const prev = await creds();
              // token 留空表示“沿用旧 token”，避免前端回填明文。
              const nextToken =
                typeof body.token === "string" && body.token.trim() !== ""
                  ? body.token
                  : prev.token;
              const next = {
                url: typeof body.url === "string" ? body.url : prev.url,
                user: typeof body.user === "string" ? body.user : prev.user,
                token: nextToken
              };
              await saveCredentials(configPath, next);
              sendJson(res, 200, { ok: true, url: next.url, user: next.user, hasToken: next.token !== "" });
              return;
            }
            res.statusCode = 405;
            res.setHeader("allow", "GET, POST");
            res.end();
          } catch (error) {
            sendJson(res, 500, { error: String(error?.message || error) });
          }
        }
      }),
    `jenkins-deploy: /config`
  );

  // --- 3) 测试连接并列出 job（按前后端/环境归类） ---
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: `${ROUTE_PREFIX}/jobs`,
        handler: route("GET", async (req, res) => {
          const c = await creds();
          // 拉取 view/kunhua 下的 job 列表。用户示例地址带 view/kunhua。
          const result = await jenkinsRequest(
            c,
            "/view/kunhua/api/json?tree=jobs[_class,name,url,color]"
          );
          if (result.status !== 200 || !result.data || !Array.isArray(result.data.jobs)) {
            sendJson(res, 502, {
              error: `Jenkins 返回异常（HTTP ${result.status}）`,
              detail: typeof result.data === "string" ? result.data.slice(0, 400) : undefined
            });
            return;
          }
          const jobs = result.data.jobs.map((job) => {
            const info = classifyJob(job.name);
            return {
              name: job.name,
              url: job.url,
              color: job.color || "",
              class: job._class,
              builtIn: String(job._class).includes("WorkflowJob"),
              ...info
            };
          });
          // 按 环境 -> 类型 -> 项目 排序，便于前端分组。
          const envOrder = { dev: 0, test: 1, prod: 2, other: 3 };
          const kindOrder = { backend: 0, frontend: 1, other: 2 };
          jobs.sort((a, b) => {
            const e = envOrder[a.env] - envOrder[b.env];
            if (e !== 0) return e;
            const k = kindOrder[a.kind] - kindOrder[b.kind];
            if (k !== 0) return k;
            return a.name.localeCompare(b.name);
          });
          sendJson(res, 200, { jobs });
        })
      }),
    `jenkins-deploy: GET ${ROUTE_PREFIX}/jobs`
  );

  // --- 4) 读取某个 job 的参数定义（判断是否有 build_branch） ---
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: `${ROUTE_PREFIX}/job`,
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          const url = new URL(String(req.url), "http://localhost");
          // 形如 /x-jenkins-deploy/job/<jobName>/params
          const segments = url.pathname.slice(ROUTE_PREFIX.length + 1).split("/");
          // segments: ["job", "<jobName>", "params"]
          if (segments.length < 3 || segments[0] !== "job" || segments[2] !== "params") {
            sendJson(res, 404, { error: "未知路由" });
            return;
          }
          const jobName = decodeURIComponent(segments[1]);
          if (req.method !== "GET") {
            res.statusCode = 405;
            res.setHeader("allow", "GET");
            res.end();
            return;
          }
          try {
            const c = await creds();
            const result = await jenkinsRequest(
              c,
              `/job/${encodeURIComponent(jobName)}/api/json?tree=property[parameterDefinitions[name,type,defaultParameterValue[value],choices]]`
            );
            if (result.status !== 200 || !result.data) {
              sendJson(res, 502, { error: `读取参数失败（HTTP ${result.status}）` });
              return;
            }
            const props = Array.isArray(result.data.property) ? result.data.property : [];
            const defs = [];
            for (const prop of props) {
              if (Array.isArray(prop.parameterDefinitions)) {
                for (const def of prop.parameterDefinitions) {
                  defs.push({
                    name: def.name,
                    type: def.type,
                    defaultValue: def.defaultParameterValue?.value ?? null,
                    choices: Array.isArray(def.choices) ? def.choices : null
                  });
                }
              }
            }
            sendJson(res, 200, { job: jobName, parameters: defs });
          } catch (error) {
            sendJson(res, 502, { error: String(error?.message || error) });
          }
        }
      }),
    `jenkins-deploy: params ${ROUTE_PREFIX}/job/<name>/params`
  );

  // --- 5) 触发构建（POST）/ 查询构建状态（GET）/ 控制台日志（GET） ---
  // 采用 prefix 路由手动拆分段：/x-jenkins-deploy/job/<jobName>/build|status|console
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: `${ROUTE_PREFIX}/build`,
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          const url = new URL(String(req.url), "http://localhost");
          // 形如 /x-jenkins-deploy/build/<jobName>  （POST，body: {branch?, params?}）
          const tail = url.pathname.slice(`${ROUTE_PREFIX}/build`.length + 1);
          const jobName = decodeURIComponent(tail.split("/")[0] || "");
          if (jobName === "") {
            sendJson(res, 400, { error: "缺少 job 名" });
            return;
          }
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.setHeader("allow", "POST");
            res.end();
            return;
          }
          try {
            const body = await readJsonBody(req);
            if (body === null) {
              sendJson(res, 400, { error: "请求体必须是 JSON 对象" });
              return;
            }
            const c = await creds();

            // 组装构建参数：优先用调用方显式给出的 params；否则若有 build_branch 则传 branch。
            const params = {};
            if (body.params && typeof body.params === "object" && !Array.isArray(body.params)) {
              for (const [k, v] of Object.entries(body.params)) {
                if (typeof k === "string" && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
                  params[k] = String(v);
                }
              }
            }
            if (typeof body.branch === "string" && body.branch !== "" && params.build_branch === undefined) {
              params.build_branch = body.branch;
            }

            const hasParams = Object.keys(params).length > 0;
            const endpoint = hasParams
              ? `/job/${encodeURIComponent(jobName)}/buildWithParameters`
              : `/job/${encodeURIComponent(jobName)}/build`;

            const result = await jenkinsRequest(c, endpoint, {
              method: "POST",
              body: hasParams ? params : undefined
            });
            // Jenkins 触发成功返回 201（或 200/302）。
            if (result.status !== 201 && result.status !== 200 && result.status !== 302) {
              sendJson(res, 502, {
                error: `触发构建失败（HTTP ${result.status}）`,
                detail: typeof result.data === "string" ? result.data.slice(0, 400) : undefined
              });
              return;
            }
            sendJson(res, 200, { ok: true, job: jobName, params });
          } catch (error) {
            sendJson(res, 502, { error: String(error?.message || error) });
          }
        }
      }),
    `jenkins-deploy: POST ${ROUTE_PREFIX}/build/<name>`
  );

  // --- 6) 构建状态与历史：/x-jenkins-deploy/status/<jobName> ---
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: `${ROUTE_PREFIX}/status`,
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          if (req.method !== "GET") {
            res.statusCode = 405;
            res.setHeader("allow", "GET");
            res.end();
            return;
          }
          const url = new URL(String(req.url), "http://localhost");
          const jobName = decodeURIComponent(url.pathname.slice(`${ROUTE_PREFIX}/status`.length + 1).split("/")[0] || "");
          if (jobName === "") {
            sendJson(res, 400, { error: "缺少 job 名" });
            return;
          }
          try {
            const c = await creds();
            const tree =
              "name,color,url,builds[number,result,building,timestamp,duration,url]{0,10},lastBuild[number,result,building,timestamp,duration,url]";
            const result = await jenkinsRequest(
              c,
              `/job/${encodeURIComponent(jobName)}/api/json?tree=${encodeURIComponent(tree)}`
            );
            if (result.status !== 200 || !result.data) {
              sendJson(res, 502, { error: `读取状态失败（HTTP ${result.status}）` });
              return;
            }
            const d = result.data;
            sendJson(res, 200, {
              name: d.name,
              color: d.color || "",
              url: d.url,
              lastBuild: d.lastBuild || null,
              builds: Array.isArray(d.builds) ? d.builds : []
            });
          } catch (error) {
            sendJson(res, 502, { error: String(error?.message || error) });
          }
        }
      }),
    `jenkins-deploy: GET ${ROUTE_PREFIX}/status/<name>`
  );

  // --- 7) 控制台日志：/x-jenkins-deploy/console/<jobName>/<buildNumber> ---
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: `${ROUTE_PREFIX}/console`,
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          if (req.method !== "GET") {
            res.statusCode = 405;
            res.setHeader("allow", "GET");
            res.end();
            return;
          }
          const url = new URL(String(req.url), "http://localhost");
          const rest = url.pathname.slice(`${ROUTE_PREFIX}/console`.length + 1);
          const parts = rest.split("/").map((p) => decodeURIComponent(p));
          const jobName = parts[0] || "";
          const buildNumber = parts[1] || "lastBuild";
          if (jobName === "") {
            sendJson(res, 400, { error: "缺少 job 名" });
            return;
          }
          try {
            const c = await creds();
            // progressiveText 可增量读取；这里直接取完整文本。
            const result = await jenkinsRequest(
              c,
              `/job/${encodeURIComponent(jobName)}/${encodeURIComponent(buildNumber)}/consoleText`
            );
            const text = typeof result.data === "string" ? result.data : "";
            // 只返回尾部 200KB，避免超大日志。
            const MAX = 200 * 1024;
            const tail = text.length > MAX ? `...（已截断前 ${text.length - MAX} 字节）...\n${text.slice(-MAX)}` : text;
            sendJson(res, 200, { job: jobName, build: buildNumber, log: tail });
          } catch (error) {
            sendJson(res, 502, { error: String(error?.message || error) });
          }
        }
      }),
    `jenkins-deploy: GET ${ROUTE_PREFIX}/console/<name>/<build>`
  );
}

export { name, inject, apply };
