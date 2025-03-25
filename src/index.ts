/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

// 将 /idev/ 替换为 /idevsig/
const replaceIdevSig = (url: string): string => {
	return url.replace(/^\/idev\//, '/idevsig/');
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const API_URL = env.WEB_URL ?? "https://github.com";
		const url = new URL(request.url);
		console.log(url);

		switch (url.pathname) {
			case "/robots.txt":
				return new Response("User-agent: *\nDisallow: /", { status: 200 });
			case "":
			case "/":
				return new Response("Hello, world!", { status: 307, headers: { "Location": "https://github.com/servless/fastsite" } });
			case "/favicon.ico":
				return new Response("Page Not found ", { status: 404 });
			default:
				break;
		}

		const targetUrl = new URL(API_URL);
		// 若目标为 /idev/ 开头，则替换为 /idevsig/
		if (targetUrl.host === 'github.com' && url.pathname.startsWith("/idev/")) {
			targetUrl.pathname = replaceIdevSig(url.pathname);
		}

		// targetUrl.pathname = url.pathname; // 设置路径
		targetUrl.search = url.search;     // 合并查询参数
		targetUrl.hash = url.hash;         // 合并片段标识符

		// console.log(targetUrl);

		const modifiedRequest = new Request(targetUrl.toString(), {
		  headers: request.headers,
		  method: request.method,
		  body: request.body,
		  redirect: "follow"
		});
		const response = await fetch(modifiedRequest);
		const modifiedResponse = new Response(response.body, response);
		modifiedResponse.headers.set("Access-Control-Allow-Origin", "*");
		return modifiedResponse;
	},
} satisfies ExportedHandler<Env>;
