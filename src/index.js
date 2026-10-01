/**
 * fastsite - 基于 Cloudflare Workers / Pages 的反向代理与站点加速
 * 
 * 主要功能：
 * - 基于 D1 数据库的高效域名与路径映射查询
 * - 支持反向代理路径重写与参数合并
 * - 支持防代理逃逸的 Location 重定向重写
 * - 支持跨域请求 (CORS) 与 OPTIONS 预检
 * - 支持 GitHub Token 自动注入以防 API 限流
 * - 支持 Google CA (ACME) 目录地址重写
 * - 支持黑名单拦截与安全防护
 */

// 禁止普通浏览器直接访问的目标域名名单
const DISABLE_BROWSER_HOSTS = [
	'github.com',
	'gitlab.com',
	'cloudflare.com',
];

// 常见浏览器 User-Agent 标识
const BROWSER_UA_KEYWORDS = [
	'Mozilla',
	'AppleWebKit',
	'Chrome',
	'Safari',
];

/**
 * 判断目标 host 是否匹配指定域名（包含主域名及其子域名）
 * @param {string} host 
 * @param {string[]} targetList 
 * @returns {boolean}
 */
function isHostMatched(host, targetList) {
	if (!host) return false;
	const lowerHost = host.toLowerCase();
	return targetList.some(item => {
		const lowerItem = item.toLowerCase();
		return lowerHost === lowerItem || lowerHost.endsWith('.' + lowerItem);
	});
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

		// 1. 处理常用静态路由
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

		// 2. 跨域 OPTIONS 预检请求直接放行
		if (request.method.toUpperCase() === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
					"Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "*",
					"Access-Control-Max-Age": "86400",
				},
			});
		}

		// 3. 构建候选 visitUrls
		const visitUrls = [
			`https://${url.host}`,
			`http://${url.host}`,
		];

		// 支持 ?from= 参数指定源站点
		const fromParam = url.searchParams.get("from");
		if (fromParam) {
			const cleanFrom = fromParam.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
			if (cleanFrom) {
				visitUrls.push(`https://${cleanFrom}`, `http://${cleanFrom}`);
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

		// 5. 禁止浏览器直接访问特定站点（如防滥用）
		if (isHostMatched(targetUrlObj.hostname, DISABLE_BROWSER_HOSTS)) {
			const userAgent = request.headers.get('user-agent') || '';
			const isBrowser = BROWSER_UA_KEYWORDS.some(keyword =>
				userAgent.toLowerCase().includes(keyword.toLowerCase())
			);
			if (isBrowser) {
				return new Response("不支持浏览器访问", {
					status: 403,
					headers: { "Content-Type": "text/plain; charset=utf-8" },
				});
			}
		}

		// 6. 构造目标 URL（正确拼接二级子路径与 Query 参数）
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

		// 7. 处理反向代理请求头
		const newHeaders = new Headers(request.headers);
		newHeaders.set('Host', forwardUrl.host);

		// 注入标准转发头
		const clientIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip');
		if (clientIp) {
			const existingXFF = request.headers.get('x-forwarded-for');
			newHeaders.set('x-forwarded-for', existingXFF ? `${existingXFF}, ${clientIp}` : clientIp);
			newHeaders.set('x-real-ip', clientIp);
		}
		newHeaders.set('x-forwarded-proto', url.protocol.replace(':', ''));
		newHeaders.set('x-forwarded-host', url.host);

		// GitHub API 自动注入 Token（仅在客户端未传入 Authorization 时注入）
		if (forwardUrl.hostname === 'api.github.com' && env?.GITHUB_TOKEN && !newHeaders.has('Authorization')) {
			newHeaders.set('Authorization', `token ${env.GITHUB_TOKEN}`);
		}

		// 8. 构建转发请求（修复 GET/HEAD 携带 body 异常）
		const reqMethod = request.method.toUpperCase();
		const hasBody = !['GET', 'HEAD'].includes(reqMethod);

		const modifiedRequest = new Request(forwardUrl.toString(), {
			headers: newHeaders,
			method: request.method,
			body: hasBody ? request.body : null,
			redirect: "follow",
		});

		// 9. 发起代理请求
		let response;
		try {
			response = await fetch(modifiedRequest);
		} catch (err) {
			return new Response(`Bad Gateway: ${err?.message || 'Upstream fetch failed'}`, {
				status: 502,
				headers: { "Content-Type": "text/plain; charset=utf-8" },
			});
		}

		// 10. 处理响应头与重写
		const responseHeaders = new Headers(response.headers);
		responseHeaders.set("Access-Control-Allow-Origin", "*");

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

		// 11. Google CA (ACME) Directory 内容重写
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

		// 12. 针对 204 No Content / 304 Not Modified 不返回 Body
		if (response.status === 204 || response.status === 304) {
			return new Response(null, {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
			});
		}

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeaders,
		});
	},
};
