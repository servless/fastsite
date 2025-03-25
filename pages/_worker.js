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

export default {
	async fetch(request, env, ctx){
		const API_URL = env.WEB_URL ?? "https://github.com";
		const url = new URL(request.url);
		// console.log(url);

		switch (url.pathname) {
			case "/robots.txt":
				return new Response("User-agent: *\nDisallow: /", { status: 200 });
			case "":
			case "/":
				return new Response("Hello, world!", { status: 307, headers: { "Location": "https://go.dsig.cn/servless/fastsite" } });
			case "/favicon.ico":
				return new Response("Page Not found ", { status: 404 });
			default:
				break;
		}

		const targetUrl = new URL(API_URL);
		targetUrl.pathname = url.pathname; // 设置路径
		targetUrl.search = url.search;     // 合并查询参数
		targetUrl.hash = url.hash;         // 合并片段标识符

		// targetUrl.host = removeProtocol(API_URL as string);
		console.log(targetUrl);

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
};

//# sourceMappingURL=index.js.map
