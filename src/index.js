/**
 * fastsite - 基于 Cloudflare Workers / Pages 的反向代理与站点加速
 * 
 * 主要功能：
 * - 完全同步客户端业务请求头（支持 AI 各种鉴权密钥，如 Authorization, x-api-key, api-key 等）
 * - 剔除导致上游 AI 服务 403 地区限制的透传头 (X-Forwarded-For / CF-IPCountry / CF-* 等)
 * - 修正 Host / Origin / Referer 避免上游防盗链及 WAF 拦截
 * - 基于 D1 数据库的高效域名与路径映射查询（参数化查询防 SQL 注入）
 * - 支持反向代理路径重写与参数合并
 * - 支持防代理逃逸的 Location 重定向重写
 * - 支持完整跨域 (CORS) 与 OPTIONS 预检
 * - 支持 Server-Sent Events (SSE) 流式传输响应
 */

/**
 * 需要被过滤或跳过的头部（逐跳头、Cloudflare 边缘头、客户端 IP/地区头）
 * 1. 避免暴露客户端地区（如 CN）给 AI 服务商（OpenAI, Claude, Gemini 等）触发 403 地区受限。
 * 2. 避免向上游 Cloudflare 节点发送伪造的 cf-* 头触发 WAF 403 拦截。
 * 3. 避免 content-length 重新计算时冲突。
 */
const DROP_HEADERS = new Set([
	// 逐跳头 (Hop-by-hop headers)
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailers',
	'transfer-encoding',
	'upgrade',
	// Cloudflare 边缘内部头
	'cf-ray',
	'cf-connecting-ip',
	'cf-ipcountry',
	'cf-visitor',
	'cf-worker',
	// 客户端 IP 透传头（清理以避免 AI 厂商识别受限地区导致 403）
	'x-real-ip',
	'x-forwarded-for',
	'x-forwarded-proto',
	'x-forwarded-host',
	'x-forwarded-port',
	'x-forwarded-server',
	// 由底层依据 body 重新计算的头
	'content-length',
]);

/**
 * 构造同步发往上游目标服务器的请求头
 * 完整同步客户端传递的所有业务头（包括各类 AI 密钥）
 */
function buildForwardHeaders(request, forwardUrl, env) {
	const newHeaders = new Headers();

	// 1. 完全同步客户端传递的所有原始请求头
	for (const [key, value] of request.headers.entries()) {
		const lowerKey = key.toLowerCase();
		if (!DROP_HEADERS.has(lowerKey)) {
			newHeaders.set(key, value);
		}
	}

	// 2. 修正 Host 为目标服务器的主机名
	newHeaders.set('Host', forwardUrl.host);

	// 3. 处理 Origin 与 Referer，防止上游 AI 服务因跨域检测或防盗链校验而报 403
	if (newHeaders.has('origin')) {
		newHeaders.set('origin', forwardUrl.origin);
	}
	if (newHeaders.has('referer')) {
		newHeaders.set('referer', forwardUrl.origin + '/');
	}

	// 4. GitHub API 兜底（仅在访问 api.github.com 且客户端未携带任何 Authorization 时注入）
	if (forwardUrl.hostname === 'api.github.com' && env?.GITHUB_TOKEN && !newHeaders.has('authorization')) {
		newHeaders.set('Authorization', `token ${env.GITHUB_TOKEN}`);
	}

	return newHeaders;
}

export default {
	/**
	 * 单个 visit_url 查询（支持外部调用，使用参数化预编译防 SQL 注入）
	 */
	async get_target_url(visit_url, env) {
		if (!env?.DB || !visit_url) {
			return null;
		}
		try {
			const sql = `SELECT target_url FROM fastsite WHERE visit_url = ? LIMIT 1`;
			const result = await env.DB.prepare(sql).bind(visit_url).first();
			return result?.target_url || null;
		} catch (err) {
			console.error('get_target_url error:', err);
			return null;
		}
	},

	/**
	 * 批量查询 visit_url 列表，优化为单次 SQL 查询，避免 N+1 往返
	 * @param {string[]} visit_url_list 候选访问地址列表
	 * @param {object} env 环境变量与绑定
	 * @returns {Promise<[string, string]|null>} 返回 [visit_url, target_url] 或 null
	 */
	async get_visit_url(visit_url_list, env) {
		if (!env?.DB || !Array.isArray(visit_url_list) || visit_url_list.length === 0) {
			return null;
		}

		// 去重
		const uniqueUrls = [...new Set(visit_url_list.filter(Boolean))];
		if (uniqueUrls.length === 0) {
			return null;
		}

		try {
			const placeholders = uniqueUrls.map(() => '?').join(',');
			const sql = `SELECT visit_url, target_url FROM fastsite WHERE visit_url IN (${placeholders})`;
			const { results } = await env.DB.prepare(sql).bind(...uniqueUrls).all();

			if (!results || results.length === 0) {
				return null;
			}

			// 转换为映射字典
			const urlMap = new Map();
			for (const row of results) {
				if (row.visit_url && row.target_url) {
					urlMap.set(row.visit_url, row.target_url.trim());
				}
			}

			// 按输入的候选列表优先级匹配第一个存在的映射
			for (const visitUrl of visit_url_list) {
				if (urlMap.has(visitUrl)) {
					return [visitUrl, urlMap.get(visitUrl)];
				}
			}
		} catch (err) {
			console.error('get_visit_url database query error:', err);
			return null;
		}

		return null;
	},

	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		// 1. 处理静态路由
		switch (url.pathname) {
			case "/robots.txt":
				return new Response("User-agent: *\nDisallow: /", {
					status: 200,
					headers: { "Content-Type": "text/plain; charset=utf-8" },
				});
			case "/favicon.ico":
				return new Response(null, { status: 404 });
			default:
				break;
		}

		// 2. 跨域 OPTIONS 预检请求：完全放行所有方法和头部（支持 Authorization、x-api-key 等所有自定义头）
		if (request.method.toUpperCase() === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
					"Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "*",
					"Access-Control-Expose-Headers": "*",
					"Access-Control-Allow-Credentials": "true",
					"Access-Control-Max-Age": "86400",
				},
			});
		}

		// 3. 构建候选 visitUrls
		const visitUrls = [
			`https://${url.host}`,
			`http://${url.host}`,
			`https://${url.host}/`,
			`http://${url.host}/`,
		];

		// 支持 ?from= 参数指定源站点
		const fromParam = url.searchParams.get("from");
		if (fromParam) {
			const cleanFrom = fromParam.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
			if (cleanFrom) {
				visitUrls.push(
					`https://${cleanFrom}`,
					`http://${cleanFrom}`,
					`https://${cleanFrom}/`,
					`http://${cleanFrom}/`
				);
			}
		}

		// 4. 查询目标反代地址
		const matchedPair = await this.get_visit_url(visitUrls, env);
		if (!matchedPair || !matchedPair[1]) {
			// 未匹配到映射时重定向到官方说明页
			return new Response("Hello, world!", {
				status: 302,
				headers: { Location: "https://github.com/servless/fastsite" },
			});
		}

		const [visitUrl, targetUrl] = matchedPair;

		let targetUrlObj;
		try {
			targetUrlObj = new URL(targetUrl);
		} catch {
			return new Response("Invalid target URL configured", { status: 502 });
		}

		// 5. 构造目标 URL（正确拼接二级子路径与 Query 参数）
		const forwardUrl = new URL(targetUrlObj.toString());
		const basePath = forwardUrl.pathname.replace(/\/+$/, '');
		const reqPath = url.pathname.replace(/^\/+/, '');
		forwardUrl.pathname = basePath ? `${basePath}/${reqPath}` : `/${reqPath}`;

		// 继承除内部 from 之外的所有查询参数
		forwardUrl.search = '';
		for (const [key, value] of url.searchParams.entries()) {
			if (key !== 'from') {
				forwardUrl.searchParams.append(key, value);
			}
		}

		// 6. 完全同步并构造请求头
		const newHeaders = buildForwardHeaders(request, forwardUrl, env);

		// 7. 构建转发请求
		const reqMethod = request.method.toUpperCase();
		const hasBody = !['GET', 'HEAD'].includes(reqMethod);

		const requestInit = {
			headers: newHeaders,
			method: request.method,
			body: hasBody ? request.body : null,
			redirect: "manual", // 避免自动跟随重定向导致跨域剥离 Authorization 等鉴权头
		};
		if (hasBody) {
			requestInit.duplex = 'half';
		}

		const modifiedRequest = new Request(forwardUrl.toString(), requestInit);

		// 8. 发起代理请求
		let response;
		try {
			response = await fetch(modifiedRequest);
		} catch (err) {
			return new Response(`Bad Gateway: ${err?.message || 'Upstream fetch failed'}`, {
				status: 502,
				headers: {
					"Content-Type": "text/plain; charset=utf-8",
					"Access-Control-Allow-Origin": "*",
				},
			});
		}

		// 9. 处理响应头（完整注入 CORS 支持）
		const responseHeaders = new Headers(response.headers);
		responseHeaders.set("Access-Control-Allow-Origin", "*");
		responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS");
		responseHeaders.set("Access-Control-Allow-Headers", "*");
		responseHeaders.set("Access-Control-Expose-Headers", "*");
		responseHeaders.set("Access-Control-Allow-Credentials", "true");

		// 防代理逃逸：重定向 Location 重写
		const locationHeader = responseHeaders.get("Location");
		if (locationHeader) {
			try {
				const locUrl = new URL(locationHeader, forwardUrl);
				if (locUrl.host === forwardUrl.host) {
					const currentOrigin = new URL(visitUrl);
					locUrl.protocol = currentOrigin.protocol;
					locUrl.host = currentOrigin.host;
					responseHeaders.set("Location", locUrl.toString());
				}
			} catch {
				// 忽略非标准或无效 Location
			}
		}

		// 10. Google CA (ACME) Directory 内容重写
		const isGoogleCa = forwardUrl.hostname === 'dv.acme-v02.api.pki.goog' || forwardUrl.hostname === 'dv.acme-v02.test-api.pki.goog';
		if (isGoogleCa && forwardUrl.pathname.endsWith('/directory')) {
			const text = await response.text();
			const newText = text
				.replaceAll('https://dv.acme-v02.api.pki.goog', visitUrl)
				.replaceAll('https://dv.acme-v02.test-api.pki.goog', visitUrl);

			return new Response(newText, {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
			});
		}

		// 11. 针对 204 No Content / 304 Not Modified 不返回 Body
		if (response.status === 204 || response.status === 304) {
			return new Response(null, {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
			});
		}

		// 12. 流式支持（如 AI SSE 事件流），原样透传 body 流
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeaders,
		});
	},
};
