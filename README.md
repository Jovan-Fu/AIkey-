AIkey后续流程一键申请 2.0.0 修复测试版

安装与测试
1. 打开 chrome://extensions，先停用原来的 GCP 自动配置扩展。
2. 打开右上角“开发者模式”，点“加载已解压的扩展程序”，选择本文件所在的 AIkey-fixed 文件夹。
3. 刷新已登录的 Google Cloud 控制台，让旧版页面脚本退出。
4. 在你要使用的 Google 账号控制台标签页，点击右下角“AIkey后续流程一键申请”（也可点扩展工具栏图标）。
5. 点“连接 Google Cloud”，确认页面显示的账号索引，选择结算账号，再点“一键全自动完成”。以后会记住结算账号选择，仍需连接以读取当前登录态。
6. 保持工作台开启。成功后自动触发 JSON 下载，API 密钥可在工作台显示、复制。若浏览器拦截下载，点“下载 JSON 私钥”。
7. 如出错，复制工作台日志给开发者即可；不要附上 API 密钥或 JSON 私钥。

保留的功能
自动新建独立项目、绑定指定结算账号、启用 API、创建服务账号、授予 roles/aiplatform.admin、生成受限且绑定服务账号的 API 密钥、生成并下载 JSON 私钥。
角色选择沿用原版管理员权限。JSON 私钥不受 API 密钥的 API 限制约束。

本版修改
- 主流程和敏感请求在扩展后台执行，结果只显示在扩展自己的工作台。
- 删除 MAIN world 注入、fetch/XHR 劫持、页面 postMessage 请求代理和私钥广播。
- 后台仅接受固定操作，并校验扩展工作台发送者。页面入口只能打开工作台。
- 只保留 5 个具体 Google API 域名；Origin/Referer 修改规则只匹配本扩展发起的请求，删除 CORS 响应头修改。
- 第一次自行选择结算账号，之后记住选择；支持结算账号分页。
- IAM 使用 policy version 3 读取并保留 etag 和既有条件绑定。
- 生成随机项目名，使用项目编号调用需要编号的接口，核验 API 密钥的服务账号绑定与 API 限制。
- 所有写入操作遇到网络超时立即停止，不盲目重试。仅在明确拒绝无效控制台 API key 时尝试另一个控制台 key。
- 不自动回滚或删除云端资源。失败时保留项目 ID 和已获取结果供检查。再次开始会创建新的项目。
- 会话结果存入仅扩展可信上下文可访问的 chrome.storage.session；不把凭据写入持久配置。持久配置只存结算账号选择。
- 后台重启时将进行中的任务标记为中断，禁止自动重放。清除会话不会撤销云端密钥。

兼容性与验证范围
为了保留免配置的一键体验，本测试版仍读取当前控制台的可访问登录 Cookie，构造 SAPISIDHASH，并使用 Google 控制台 clients6 接口；不是正式 OAuth 集成，可能受 Google 登录策略、组织策略或接口变更影响。
未申请 cookies、debugger 或全站访问权限。scripting 仅用于目标 Google 控制台的隔离上下文读取，storage 用于配置和会话结果，剪贴板权限用于主动复制密钥。
已完成 JavaScript 语法检查和离线模拟测试：成功全流程、伪造消息拒绝、结算账号校验、并发任务拒绝、IAM 条件/etag 保留、错误操作检测、密钥绑定错误停止、写入超时不重放、清除会话及无页面消息广播。
尚未在真实 Chrome 登录态下执行付费云端创建流程，实际登录/接口兼容性需由你测试。测试本身也会创建真实资源。

开发者复测
在本文件夹运行：node --test tests/security.test.mjs
original-sha256.json 是原始扩展的文件摘要，原目录未修改。

参考
https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
https://developer.chrome.com/docs/extensions/reference/api/scripting
https://docs.cloud.google.com/iam/docs/allow-policies
https://docs.cloud.google.com/docs/authentication/api-keys
