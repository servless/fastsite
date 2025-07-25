# fastsite

基于 CloudFlare Workers / Pages 的指定网站加速

## 初始化

1. 拉取本仓库代码

2. 安装模块
```bash
npm install -g wrangler
```

3. 初始化数据库

```bash
# 创建数据库
wrangler d1 create fastsite
```

复制生成的数据库信息到 `wrangler.jsonc`
```bash
✅ Successfully created DB 'fastsite' in region WEUR
Created your new D1 database.

{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "fastsite",
      "database_id": "4791dbb8-a06b-4980-9992-f51c51c47f70"
    }
  ]
}
```

创建数据表结构文件 `schema.sql`，并填充数据。

```bash
# 导入数据结构(本地测试)
wrangler d1 execute fastsite --env local --local --file=./schema.sql
# 导入数据结构(远程服务)
wrangler d1 execute fastsite --remote --file=./schema.sql
```

- 本地测试使用 `--local`，生产环境使用 `--remote`
```bash
# 查询表结构
wrangler d1 execute fastsite --local --command="pragma table_info(fastsite)"

# 查询数据表
wrangler d1 execute fastsite --local --command="SELECT * FROM fastsite"

# 备份数据库
wrangler d1 export fastsite --local --file=./fastsite.sql

# 添加数据
wrangler d1 execute fastsite --local --command="INSERT INTO fastsite (visit_url, target_url, description) VALUES ('https://mydomain.com', 'https://www.baidu.com', '百度')"

# 更新数据
wrangler d1 execute fastsite --local --command="UPDATE fastsite SET target_url = 'https://www.baidu.com' WHERE id = 1"

# 删除数据
wrangler d1 execute fastsite --local --command="DELETE FROM fastsite WHERE id = 1"
```

## 表结构说明

```bash
CREATE TABLE IF NOT EXISTS fastsite (
    id INTEGER PRIMARY KEY, -- ID
    visit_url TEXT NOT NULL, -- 访问地址
    target_url TEXT NOT NULL, -- 目标地址
    description TEXT DEFAULT '' NULL -- 描述
);
```

1. `visit_url` 为访问的网站地址（**需要绑定域名到此服务**）。
2. `target_url` 为加速的目标网站地址。
3. `description` 为网站描述。

## 本地测试
```bash
npm run dev
```

## 部署教程 - Workers

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/servless/fastsite&paid=true)

### 通过 GitHub Actions 发布至 CloudFlare

从 CloudFlare 获取 [`CLOUDFLARE_API_TOKEN`](https://dash.cloudflare.com/profile/api-tokens) 值（`编辑 Cloudflare Workers`），并设置到项目。

> `https://github.com/<ORG>/dchere/settings/secrets/actions`

### 本地部署到 CloudFlare

1. 注册 [CloudFlare 账号](https://www.cloudflare.com/)，并且设置 **Workers** 域名 (比如：`abcd.workers.dev`)
2. 安装 [Wrangler 命令行工具](https://developers.cloudflare.com/workers/wrangler/)。
   ```bash
   npm install -g wrangler
   ```
3. 登录 `Wrangler`（可能需要扶梯）：

   ```bash
   # 登录，可能登录不成功
   # 若登录不成功，可能需要使用代理。
   wrangler login
   ```

4. 拉取本项目：

   ```bash
   git clone https://github.com/servless/fastsite.git
   ```

5. 修改 `wrangler.json` 文件中的 `name`（fastsite）为服务名 `myfastsite`（访问域名为：`myfastsite.abcd.workers.dev`）。

6. 发布

   ```bash
    wrangler deploy
   ```

   发布成功将会显示对应的网址

   ```bash
    Proxy environment variables detected. We'll use your proxy for fetch requests.
   ⛅️ wrangler 4.4.0
   	--------------------
   	Total Upload: 0.66 KiB / gzip: 0.35 KiB
   	Uploaded myfastsite (1.38 sec)
   	Published myfastsite (4.55 sec)
   		https://myfastsite.abcd.workers.dev
   	Current Deployment ID:  xxxx.xxxx.xxxx.xxxx
   ```

   **由于某些原因，`workers.dev` 可能无法正常访问，建议绑定自有域名。**

7. 绑定域名

   在 **Compute (Workers)** -> **Workers & Pages** -> **Settings** -> **Domains & Routes** -> **Add** -> **Custom Domain**（仅支持解析在 CF 的域名），按钮以绑定域名。

## 部署教程 - Pages

### 直接连接到 `GitHub` 后,一键部署

### 本地部署到 CloudFlare

- 修改代码 [`pages/_worker.js`]

1. 登录请参考 **Workers** 中的**本地部署**的步骤 `1~4`

2. 发布

	```bash
	 wrangler pages deploy pages --project-name fastsite
	```

	发布成功将会显示对应的网址

	```bash
		▲ [WARNING] Pages now has wrangler.toml support.

			We detected a configuration file at
			Ignoring configuration file for now, and proceeding with project deploy.

			To silence this warning, pass in --commit-dirty=true


		✨ Success! Uploaded 0 files (11 already uploaded) (0.38 sec)

		✨ Compiled Worker successfully
		✨ Uploading Worker bundle
		🌎 Deploying...
		✨ Deployment complete! Take a peek over at https://2e4bd9c5.dcba.pages.dev
	```

   **由于某些原因，`pages.dev` 可能无法正常访问，建议绑定自有域名。**

3. 绑定域名

   在 **Compute (Workers)** -> **Workers & Pages** -> **Custom domains** -> **Add Custom Domain**（支持解析不在 CF 的域名），按钮以绑定域名。

## 仓库镜像

- https://git.jetsung.com/servless/fastsite
- https://framagit.org/servless/fastsite
- https://github.com/servless/fastsite
