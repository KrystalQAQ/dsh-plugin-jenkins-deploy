// 部署发布插件 —— 面向 agent 的工具定义（Host 侧）
//
// 该模块把 Jenkins 部署能力封装成模型可调用的工具，与 UI 页面共用同一套
// 凭据文件与 Jenkins 调用逻辑。工具在插件 apply 时注册到 ctx.tools。
//
// 设计原则：
//   - 只读类（list / status）随时可用；
//   - 写操作（trigger）对生产环境强制二次确认：未显式 confirm_production=true 时，
//     只返回 needs_confirmation，不真正触发，促使模型向用户确认；
//   - 永不回显 Token；错误以结构化 { ok:false, code, message } 返回而非抛异常。
import { defineTool } from "@deepseek-ai/dsh-tools";

/** 统一错误结果。 */
function fail(code, message) {
  return { ok: false, code, message };
}

/** 统一成功结果。 */
function okResult(extra) {
  return { ok: true, ...extra };
}

/**
 * 把 Jenkins 原始 job 列表归类并可选按关键字过滤。
 * @param {Array} rawJobs - Jenkins 返回的 jobs 数组。
 * @param {string} query - 可选关键字（匹配 job 名，不区分大小写）。
 * @param {(name:string)=>{kind:string,kindLabel:string,env:string,envLabel:string,project:string}} classify - 归类函数。
 * @returns {Array} 归类后的 job 列表。
 */
function mapJobs(rawJobs, query, classify) {
  const q = (query || "").trim().toLowerCase();
  const list = rawJobs
    .map((job) => {
      const info = classify(job.name);
      return {
        name: job.name,
        url: job.url,
        color: job.color || "",
        env: info.env,
        envLabel: info.envLabel,
        kind: info.kind,
        kindLabel: info.kindLabel
      };
    })
    .filter((job) => (q === "" ? true : job.name.toLowerCase().includes(q)));
  return list;
}

/**
 * 注册全部部署相关工具。
 * @param {any} ctx - Cordis 上下文，需含 tools 服务。
 * @param {object} deps - 依赖注入。
 * @param {() => Promise<{url:string,user:string,token:string}>} deps.creds - 读取当前凭据。
 * @param {(creds:any, path:string, options?:any)=>Promise<{status:number,data:any}>} deps.request - Jenkins API 调用。
 * @param {(name:string)=>object} deps.classify - job 归类函数。
 */
function registerTools(ctx, deps) {
  const { creds, request, classify } = deps;

  // 校验凭据是否已配置；未配置返回错误对象。
  const ensureConfigured = async () => {
    const c = await creds();
    if (!c.url) return { error: fail("not_configured", "尚未配置 Jenkins 地址，请先在「部署发布」设置中填写。") };
    if (!c.user || !c.token) return { error: fail("not_configured", "尚未配置 Jenkins 用户名或 Token，请先在「部署发布」设置中填写。") };
    return { c };
  };

  // ------------------------------------------------------------------
  // 工具 1：jenkins_deploy_list —— 列出可部署项目
  // ------------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: "jenkins_deploy_list",
      description:
        "列出 Jenkins 上可部署的前后端项目，按环境（dev/test/prod）与类型（前端/后端）归类，并附带最近一次构建状态。可用 query 关键字按项目名过滤。用于部署前先确认准确的 job 名称。",
      parameters: {
        query: {
          type: "string",
          description: "可选，按 job 名模糊过滤的关键字（不区分大小写），如 wuliu、pay、frontend。"
        }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            ok: { type: "boolean", required: true },
            jobs: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  name: { type: "string", required: true },
                  env: { type: "string", required: true },
                  envLabel: { type: "string", required: true },
                  kind: { type: "string", required: true },
                  kindLabel: { type: "string", required: true },
                  lastBuild: {
                    type: "object",
                    additionalProperties: true,
                    properties: {
                      number: { type: "number" },
                      result: { type: "string" },
                      building: { type: "boolean" },
                      timestamp: { type: "number" }
                    }
                  }
                }
              }
            },
            code: { type: "string" },
            message: { type: "string" }
          }
        },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }]
      },
      async execute(args) {
        const configured = await ensureConfigured();
        if (configured.error) return configured.error;
        try {
          const res = await request(configured.c, "/view/kunhua/api/json?tree=jobs[name,url,color]");
          if (res.status !== 200 || !res.data || !Array.isArray(res.data.jobs)) {
            return fail("jenkins_error", `Jenkins 返回异常（HTTP ${res.status}）。`);
          }
          const jobs = mapJobs(res.data.jobs, args.query, classify);
          // 并发拉取每个 job 的最近构建（限流：只取前 40 个，避免过多请求）。
          const withStatus = await Promise.all(
            jobs.slice(0, 40).map(async (job) => {
              try {
                const st = await request(configured.c, `/job/${encodeURIComponent(job.name)}/api/json?tree=lastBuild[number,result,building,timestamp]`);
                const lb = st.status === 200 && st.data ? st.data.lastBuild : null;
                return lb ? { ...job, lastBuild: { number: lb.number, result: lb.result, building: lb.building, timestamp: lb.timestamp } } : job;
              } catch {
                return job;
              }
            })
          );
          return okResult({ jobs: withStatus });
        } catch (error) {
          return fail("network_error", String(error?.message || error));
        }
      }
    })
  );

  // ------------------------------------------------------------------
  // 工具 2：jenkins_deploy_status —— 查询单个 job 的构建状态/日志
  // ------------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: "jenkins_deploy_status",
      description:
        "查询某个 Jenkins job 的最近构建状态与最近若干次构建历史；可选把某次构建（默认最后一次）的控制台日志尾部一并返回，用于排查部署结果。",
      parameters: {
        job: { type: "string", required: true, description: "精确的 Jenkins job 名称，如 kh-wuliu-server-backend-dev。" },
        build: { type: "string", description: "可选，构建号（如 199）。省略时取最近一次构建。" },
        with_console: { type: "boolean", description: "可选，是否附上该次构建的控制台日志尾部（默认 false）。" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            ok: { type: "boolean", required: true },
            job: { type: "string" },
            lastBuild: {
              type: "object",
              additionalProperties: true,
              properties: {
                number: { type: "number" },
                result: { type: "string" },
                building: { type: "boolean" },
                timestamp: { type: "number" },
                duration: { type: "number" },
                url: { type: "string" }
              }
            },
            builds: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  number: { type: "number" },
                  result: { type: "string" },
                  building: { type: "boolean" },
                  timestamp: { type: "number" }
                }
              }
            },
            console: { type: "string" },
            code: { type: "string" },
            message: { type: "string" }
          }
        },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }]
      },
      async execute(args) {
        const configured = await ensureConfigured();
        if (configured.error) return configured.error;
        const job = String(args.job || "").trim();
        if (!job) return fail("invalid_args", "job 不能为空。");
        try {
          const tree = "name,color,url,lastBuild[number,result,building,timestamp,duration,url],builds[number,result,building,timestamp]{0,10}";
          const res = await request(configured.c, `/job/${encodeURIComponent(job)}/api/json?tree=${encodeURIComponent(tree)}`);
          if (res.status !== 200 || !res.data) return fail("jenkins_error", `读取状态失败（HTTP ${res.status}）。`);
          const d = res.data;
          const result = okResult({
            job: d.name,
            lastBuild: d.lastBuild || null,
            builds: Array.isArray(d.builds) ? d.builds : []
          });
          if (args.with_console) {
            const buildNo = args.build && String(args.build).trim() !== "" ? String(args.build).trim() : "lastBuild";
            try {
              const logRes = await request(configured.c, `/job/${encodeURIComponent(job)}/${encodeURIComponent(buildNo)}/consoleText`);
              const text = typeof logRes.data === "string" ? logRes.data : "";
              const MAX = 200 * 1024;
              result.console = text.length > MAX ? `...（已截断前 ${text.length - MAX} 字节）...\n${text.slice(-MAX)}` : text;
            } catch (e) {
              result.console = `读取日志失败：${String(e?.message || e)}`;
            }
          }
          return result;
        } catch (error) {
          return fail("network_error", String(error?.message || error));
        }
      }
    })
  );

  // ------------------------------------------------------------------
  // 工具 3：jenkins_deploy_trigger —— 触发部署（生产需二次确认）
  // ------------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: "jenkins_deploy_trigger",
      description:
        "触发一次 Jenkins 构建（部署）。branch 默认 dev。生产环境（job 名含 prod）必须显式传 confirm_production=true 才会真正触发；否则返回 needs_confirmation，提示你向用户确认。对于参数化的 job，会自动以 buildWithParameters 携带 build_branch。",
      parameters: {
        job: { type: "string", required: true, description: "要部署的 Jenkins job 名称，如 kh-wuliu-server-backend-dev。" },
        branch: { type: "string", description: "可选，分支参数 build_branch，默认 dev；生产通常为 master。" },
        confirm_production: { type: "boolean", description: "部署生产（prod）环境时必须为 true，否则不会真正触发。" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            ok: { type: "boolean", required: true },
            needs_confirmation: { type: "boolean" },
            job: { type: "string" },
            env: { type: "string" },
            params: { type: "object", additionalProperties: true },
            build: { type: "number" },
            message: { type: "string" },
            code: { type: "string" }
          }
        },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }]
      },
      async execute(args) {
        const configured = await ensureConfigured();
        if (configured.error) return configured.error;
        const job = String(args.job || "").trim();
        if (!job) return fail("invalid_args", "job 不能为空。");
        const info = classify(job);

        // 生产环境强制二次确认：未确认则只返回提示，不触发。
        if (info.env === "prod" && args.confirm_production !== true) {
          return {
            ok: false,
            needs_confirmation: true,
            job,
            env: "prod",
            message: `「${job}」是生产环境任务。请先向用户确认：是否真的部署到生产？确认后再调用本工具并传 confirm_production=true。`
          };
        }

        // 组装参数：分支
        const params = {};
        if (typeof args.branch === "string" && args.branch.trim() !== "") params.build_branch = args.branch.trim();

        try {
          const hasParams = Object.keys(params).length > 0;
          const endpoint = hasParams
            ? `/job/${encodeURIComponent(job)}/buildWithParameters`
            : `/job/${encodeURIComponent(job)}/build`;
          const res = await request(configured.c, endpoint, { method: "POST", body: hasParams ? params : undefined });
          if (res.status !== 201 && res.status !== 200 && res.status !== 302) {
            return fail("jenkins_error", `触发构建失败（HTTP ${res.status}）。`);
          }
          // 触发后读取一次最新构建号（可能略有延迟）。
          let buildNo;
          try {
            const st = await request(configured.c, `/job/${encodeURIComponent(job)}/api/json?tree=lastBuild[number]`);
            buildNo = st.status === 200 && st.data?.lastBuild ? st.data.lastBuild.number : undefined;
          } catch {
            /* 忽略 */
          }
          return okResult({ job, env: info.env, params, build: buildNo, message: "已触发构建。" });
        } catch (error) {
          return fail("network_error", String(error?.message || error));
        }
      }
    })
  );
}

export { registerTools };
