# 来源与依赖

- 本仓库的核心模块从一次为 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 开发的本地知乎扩展抽取，新增独立配置、管理服务、DSH 原生插件及 MCP 适配。不是 qq-bridge 上游已发布功能的声明。保留 MIT 及相关贡献者署名。
- 目标用户个人动态页的监测思路参考 [amchii/ZhiArchive](https://github.com/amchii/ZhiArchive)，没有打包其归档服务或直接复制其实现。
- DSH 原生工具使用 `@deepseek-ai/dsh-tools` 的公开 `defineTool` / `tools.register` 接口。接口形式参考已安装 DSH 的类型声明及现有插件示例。
- `@modelcontextprotocol/sdk` 提供 MCP 标准输入输出传输；`zod` 用于 MCP 参数；`playwright-core` 驱动用户安装的 Chromium。依赖的许可见各包中的 LICENSE 和锁文件版本。
- 不含 DSH、SnowLuma、QQ 客户端、浏览器二进制或知乎客户端；不提供对这些组件的再分发授权。
- 非知乎、DeepSeek、qq-bridge 或 SnowLuma 官方产品。用户需使用自己的账号和授权；网站是否接受访问由其服务决定。
