/**
 * Cloudflare Worker：准点触发 GitHub Actions 的 workflow_dispatch。
 *
 * 用途：替代不可靠的 GitHub `schedule`（每小时可能被跳过）。
 *       在 Cloudflare 上配置 Cron Trigger `30 * * * *`（UTC），
 *       由于北京是 UTC+8（整小时偏移），UTC 的 :30 == 北京时间的 :30，
 *       因此每天都会在 00:30、01:30 … 23:30（北京时间）准点触发一次抓取。
 *
 * 需要的配置（在 Worker 的 Settings 里）：
 *   Secrets（加密，推荐）:
 *     GITHUB_TOKEN   —— 有 `Actions: Read and write` 的 Fine-grained PAT
 *   Variables / Plaintext（可选，留空则用下面的默认值）:
 *     GITHUB_OWNER   默认 wwr650
 *     GITHUB_REPO    默认 POE2-currency
 *     GITHUB_WORKFLOW 默认 fetch-summary.yml
 *     GITHUB_REF     默认 main
 *
 * 免费层足够：每天约 48 次定时调用，远低于 10 万次/天上限。
 */

const DEFAULTS = {
  GITHUB_OWNER: "wwr650",
  GITHUB_REPO: "POE2-currency",
  GITHUB_WORKFLOW: "fetch-summary.yml",
  GITHUB_REF: "main",
};

/** 调用一次 GitHub workflow_dispatch 接口。 */
async function triggerWorkflow(env) {
  const owner = env.GITHUB_OWNER || DEFAULTS.GITHUB_OWNER;
  const repo = env.GITHUB_REPO || DEFAULTS.GITHUB_REPO;
  const workflow = env.GITHUB_WORKFLOW || DEFAULTS.GITHUB_WORKFLOW;
  const ref = env.GITHUB_REF || DEFAULTS.GITHUB_REF;
  const token = env.GITHUB_TOKEN;

  if (!token) {
    return { status: 0, error: "GITHUB_TOKEN secret is not configured on this Worker" };
  }

  const url =
    `https://api.github.com/repos/${owner}/${repo}` +
    `/actions/workflows/${workflow}/dispatches`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "poe2-currency-fetch-trigger",
      },
      body: JSON.stringify({ ref }),
    });
  } catch (err) {
    return { status: 0, error: `network error: ${err && err.message}` };
  }

  // GitHub 成功时返回 204 No Content（响应体为空）
  const text = await response.text().catch(() => "");
  return {
    ok: response.status === 204,
    status: response.status,
    body: text,
    url,
  };
}

export default {
  // Cron Trigger 入口：到点由 Cloudflare 调用
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const result = await triggerWorkflow(env);
        console.log(`[fetch-trigger] dispatched: ${JSON.stringify(result)}`);
      })()
    );
  },

  // HTTP 入口：便于「手动测试一次」——浏览器访问 Worker URL 即触发
  // 注意：该端点只会用服务端 token 触发本仓库抓取，不泄露令牌。
  async fetch(request, env) {
    const result = await triggerWorkflow(env);
    return new Response(
      JSON.stringify(
        {
          message: result.ok
            ? "✅ 已触发 GitHub 工作流（204）"
            : "❌ 触发失败，请检查 GITHUB_TOKEN / 仓库权限 / 文件名",
          detail: result,
        },
        null,
        2
      ),
      {
        status: result.ok ? 200 : 502,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }
    );
  },
};
