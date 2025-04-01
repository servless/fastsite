/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const disableBrowser = [
	'github.com',
	'gitlab.com',
	'cloudflare.com',
]

const disableAgent = [
	'Mozilla',
	'AppleWebKit',
	'Chrome',
	'Safari',
]

export default {
	async fetch(request, env, ctx) {
		const API_URL = env.WEB_URL ?? "https://github.com";
		const url = new URL(request.url);
		// console.log(url);

		switch (url.pathname) {
			case "/robots.txt":
				return new Response("User-agent: *\nDisallow: /", { status: 200 });
			case "":
			case "/":
				return new Response("Hello, world!", { status: 302, headers: { "Location": "https://github.com/servless/fastsite" } });
			case "/favicon.ico":
				return new Response("资源未找到", { status: 404 });
			default:
				break;
		}

		const targetUrl = new URL(API_URL);
		// 禁止浏览器访问
		if (disableBrowser.indexOf(targetUrl.host) === 0) {
			const userAgent = request.headers.get('user-agent').toLowerCase();
			// 检查是否包含 disableAgent 中的关键词
			const containsDisableAgent = disableAgent.some(keyword => {
				return userAgent.includes(keyword.toLowerCase());
			});
			if (containsDisableAgent) {
				return new Response("不支持浏览器访问", { status: 500 });
			}
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
};

