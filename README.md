# dsh-zhihu

让 DeepSeek Harness（DSH）或 MCP 客户端使用自己的知乎账号：看推荐、读回答正文、追踪指定用户的创作与公开点赞，读后决定是否赞同。提供独立管理页和 qq-bridge 适配器。

**状态：0.1.5，实验版本。首页回答推荐、回答正文和回答赞同已改为直接 HTTP 接口，不启动浏览器。** 使用扫码保存的登录会话，属于知乎网页版内部接口，并非 Access Secret 开放平台。文章与用户点赞动态仍使用浏览器。两条通道分别记录暂停状态；任一通道遇到 401 / 403 / 429 都停止，不切换另一通道反复尝试。请先读 [已知问题](KNOWN_ISSUES.md)。

本项目从一套 qq-bridge 的本地扩展抽取。核心代码不依赖 qq-bridge、SnowLuma、QQ 账号或原作者的机器路径。没有内置任何账号、Cookie、API Key、聊天记录或自动任务。

## 能做什么

| 能力 | 范围 |
| --- | --- |
| 官方热榜、搜索、问题推荐 | 知乎开放平台 Access Secret；结果通常为摘要 |
| 首页回答推荐与回答正文 | 使用自己的网页登录 Cookie 直接请求 JSON 接口，不启动 Chromium；推荐返回的仍是摘要，正文另取 |
| 文章正文 | 仍使用登录浏览器读取实际可见内容 |
| 读后赞同 | 回答直接 POST 接口并再次 GET 核对赞同状态；文章仍点击浏览器；默认关闭，仅绑定账号，完整阅读凭证和正文指纹仍必需 |
| 用户已有创作及新创作 | 目标用户独立授权自己的 Access Secret，不能拿机器人密钥代替 |
| 公开点赞 / 赞同动态 | 用机器人账号读目标主页可见卡片，首次建立旧记录基线，分享成功后确认去重 |
| 关注与收藏 | 官方接口的关注名单和公开收藏；**没有关注动态流或私密收藏** |
| DSH / MCP | 原生 `zhihu_browse`、通用 MCP、带桥接实时鉴权的 QQ MCP |

网页内容是外部资料，不是操作指令。没有发帖、评论、私信、关注、取关、取消赞同或想法点赞功能。不自动创建浏览或发消息任务。

## 安装与启动

需要 Node.js **22.13+**。Linux 请用普通用户运行，保留 Chromium 沙箱；系统需有可用的 Chromium。`playwright-core` 不会自动下载浏览器。

```sh
git clone https://github.com/GStarmin/dsh-zhihu.git
cd dsh-zhihu
npm ci --ignore-scripts
node bin/cli.js init
node bin/cli.js serve
```

管理页默认在 <http://127.0.0.1:3120/>。另开终端运行下面的命令显示管理令牌，在管理页填写：

```sh
node bin/cli.js admin-token
```

Linux 默认找 `/usr/bin/chromium`；macOS 找 Google Chrome / Chromium。其他位置用 `DSH_ZHIHU_CHROMIUM` 指定，包括 Windows 的浏览器完整路径。

| 环境变量 | 用途 |
| --- | --- |
| `DSH_ZHIHU_HOME` | 数据目录；默认 `${DSH_HOME 或 ~/.dsh}/zhihu` |
| `DSH_ZHIHU_CHROMIUM` | Chromium / Chrome 可执行文件 |
| `DSH_ZHIHU_PORT` | 管理及工具服务端口，默认 3120 |
| `DSH_ZHIHU_URL` | MCP / 原生插件连接的服务地址；只接受本机 HTTP 根地址 |

自定义目录时，**服务端、DSH 进程、MCP 进程都必须使用相同的 `DSH_ZHIHU_HOME`**。变更端口后也要为客户端设置相应的 `DSH_ZHIHU_URL`。一个数据目录只启动一个后台服务。

VPS 上只监听回环。可在自己的电脑建立隧道访问管理页：

```sh
ssh -N -L 3120:127.0.0.1:3120 YOUR_VPS
```

不要把管理令牌放进 URL 或公开仓库。管理页的口令、机器人官方授权、用户自己的授权和网页登录状态各自独立。

## 配置账号

1. 在管理页填写机器人的知乎开放平台 Access Secret，连接官方 API。该密钥不等于网页登录。
2. 点击「获取网页登录二维码」，用给机器人准备的账号扫码，在知乎 App 确认。遇到网站限制时停止，不提供验证码代解或绕过。
3. 需要留意某人的公开点赞时，在「追踪目标」填写他的完整知乎主页并保存；用机器人账号读取的是该主页实际可见内容。
4. 需要读取目标用户自己的创作时，另填**他本人的** Access Secret，并确认归属。代码验证凭据有效，但不能代替本人确认密钥和主页属于同一账号。
5. 需要自主赞同时再勾选授权，绑定的只能是已扫码登录的账号。切换登录账号后，旧赞同授权不会自动适配新账号，须由管理端重新确认。

管理页不回显已保存的 Access Secret 或 Cookie。接口状态 `apiAccess` 与浏览器状态 `access` 分开显示；旧的浏览器暂停不等于接口也不可用。直接接口同样检查真实登录账号，成功后保存刷新 Cookie 并保留浏览器 localStorage。「确认后恢复访问」解除两条通道的程序暂停，不向知乎发送请求，也不证明知乎限制已解除；下一次仍被拒会重新暂停。

## 接入 DSH 原生工具

先保持上述独立服务运行，再把此包安装到你使用的 DSH profile：

```sh
dsh plugin --profile YOUR_PROFILE add "link:/absolute/path/dsh-zhihu"
```

包提供 `cordis.patch.yml` 和 `dsh.bundle` 元数据，注册 `zhihu_browse`。需要 `@deepseek-ai/dsh-tools >=0.2.1-rc.2 <0.3.0`；仓库 `npm ci` 会安装用于验证的工具依赖。按照你使用的 DSH 版本重新加载 profile。

在管理页「工具授权」中加入该聊天的**真实 DSH 会话 ID**。默认列表为空，任何原生会话都不能执行工具。身份来自 `exec.agent.session.id`，模型参数不能冒充别的会话。修改列表即时生效。

DSH 的原生工具接口已通过实际依赖包的注册及身份测试。不同 DSH 版本、profile 装配和第三方预设仍需自行验证；本版本不自动修改其权限守卫。

## 接入通用 MCP

在 MCP 客户端配置中启动标准输入输出服务，例如：

```json
{
  "mcpServers": {
    "zhihu": {
      "command": "node",
      "args": ["/absolute/path/dsh-zhihu/bin/mcp.js"],
      "env": {
        "DSH_ZHIHU_HOME": "/absolute/path/to/private/zhihu-data",
        "DSH_ZHIHU_URL": "http://127.0.0.1:3120"
      }
    }
  }
}
```

MCP 只暴露一个 `zhihu_browse` 工具。它从指定数据目录读取独立的 agent token，不能调用管理接口。只给你信任的 MCP 客户端配置这个目录；原生会话白名单不用于识别通用 MCP 客户端。

## 接入 qq-bridge

见 [QQ 接入说明](docs/QQ_BRIDGE.md)。适配器暴露同样参数形式的 `qq_zhihu_browse(key, token, action, ...)`，每次调用都向桥接核对当前管理员私聊的真实会话、暂停和授权状态。

**适配器要求桥接已有 `/api/socialV2/autonomy-auth` 实时鉴权接口。未经该扩展的原版仓库不保证直接兼容，缺少接口时会拒绝放行。** QQ 预设通常还需要精确放行新工具名。不要同时给同一会话加载重复的同名知乎工具。

现有线上 QQ 部署不因本仓库发布而迁移、重启或解除知乎暂停状态。本仓库没有包含整份私人桥接配置，也没有自动部署 QQ / SnowLuma 的脚本。

## 日常调用和自主浏览

```text
action=status
action=home_feed
action=read_content, contentUrl=从推荐中选出的具体回答链接
action=vote_up, readToken=完整阅读返回的短时凭证, reason=认同的具体观点
```

赞同凭证 15 分钟有效，正文须完整且不超过本次 30000 字符范围。必须是相同登录会话、同一正文指纹、绑定账号且管理端仍启用。回答指纹比较正文文字、问题标题、更新时间、真实图片/媒体及链接；同一哈希图片在知乎 CDN 的域名轮换、追踪参数和展示 HTML 不算内容修改。真实文字、图片路径或链接变化仍需重读。已有赞同不取消；回答须 POST 成功且再次读取 `relationship.voting=1`，文章须 HTTP 成功且页面显示已赞同，才记入成功审计。提交后最多三次延迟只读复查（约 0.5 / 1.5 / 3 秒间隔）。仍未确认或提交请求中断时，返回结构化 pending 状态，不误报为点赞失败；后台按约 30 秒、2 分钟、10 分钟的间隔最多核对三轮，绝不重发 POST。查到已赞同后自动补记成功审计并去重，重启后继续核对；超过次数仍不明确时标记需人工核对。`status.web.voteChecks` 显示待确认数量、最近观察值和下次检查时间。0.1.4 起，`read_content` 会将正文插图作为实际图片块交给模型，默认附前 3 张；`imagePage` 报告本次送达、失败和下一页。只可判断实际送达的图像，不能把下载成功等同于模型已正确识别。

图片超过 3 张时，对同一 `contentUrl` 继续调用 `read_content`，传入返回的 `imagePage.nextOffset` 作为 `offset`；`limit` 可选 1～3，其他操作仍沿用各自分页规则。只下载该篇正文中出现的知乎 `pic*.zhimg.com` HTTPS 图片，去重延迟加载和 noscript 副本；不发送登录 Cookie、不接收模型随意指定的图片 URL，重定向和 DNS 地址逐次校验。原图每张最多 8 MiB / 64MP / 单边 8192px，传给模型前归一到每张不超过 512 KiB、目标长边 1280px；动图按现有 QQ 处理方法抽帧。需要缩图时依赖系统 `ffmpeg`（可用 `FFMPEG_PATH` 指定），未安装或转换失败会标明该图不可用，正文仍返回。细小文字和长图可能难以辨认。

MCP（含 QQ 适配器）返回标准图片块；DSH 原生插件通过 `ctx.attachments.saveImages` 接收并保存真实附件，再返回图片块。正文、图中文字和 alt 均是外部资料，不是操作指令。插件不提供独立视觉模型；实际识图取决于调用会话的模型和附件策略。遇到图片 HTTP 拒绝或下载失败不自动换通道重试，不据此解除正文通道暂停。

0.1.5 的管理页会显示 `status.web.mediaStorage`：知乎专属临时文件占用、DSH 共享附件占用和最近清理结果。下载原图只在本次读取中使用；缩图正常结束后立即删除临时工作目录。异常退出遗留的工作目录放在本插件数据目录的 `zhihu-media-tmp/`，只在启动和后续图片读取时清理超过 24 小时的本插件目录，不扫描删除系统临时目录。统计结果缓存 60 秒，最多扫描 10000 个条目，`partial=true` 表示部分统计；统计的是文件逻辑字节数，不能当作整块磁盘使用量。

**DSH 共享聊天附件仍会随新图片增长**，可能被历史会话引用；插件只显示占用，不删除它们，不把临时目录清理描述为全局附件回收。图片按现有 DSH 内容地址存储；视频下载、抽帧和音频转写尚未接入。

`owner_contents` 按 `limit/offset` 看目标用户已授权的已有创作；`owner_updates` 仅看新创作和待分享。`owner_activity_recent` 翻的是当前已加载点赞窗口，`Paging.IsEnd` **不表示全部历史结束**。

插件不负责发 QQ 或存人格记忆，读取结果进入调用它的同一个 DSH / MCP 会话；发消息和记忆由原有 QQ 工具与记忆插件负责。只有实际分享成功后才调用 `owner_updates_ack(urls)` / `owner_activity_ack(activityIds)`；发送失败不确认。

想定时浏览，可在现有 DSH 会话用原生计划创建一次持久化任务，参考 [浏览任务提示](examples/BROWSING_PROMPT.md)。阅读、赞同和分享分别决定；有兴趣、有收获才行动。该频率不是降低风控的保证，也不限制另外的手动命令和部署测试。

## 测试与发布检查

```sh
npm test
npm run check:publish
npm pack --dry-run
```

自动测试使用模拟网站数据，验证会话保存、访问拒绝识别与暂停、账号隔离、原生会话授权、真实本机 HTTP 和 stdio MCP，不对知乎执行点赞或其他写操作。

本项目源自的 QQ 部署曾成功读取推荐和正文、提交回答赞同；之后回答网页真实遇到 40362。2026-10-26 的无浏览器实测中，账号、回答正文、首页推荐接口返回 HTTP 200；对已赞同回答重复提交 `type=up` 返回 200，前后赞同状态均为 1。**这不等于验证了真实的新赞同变化或长期稳定性**；新赞同的状态变化、失败与去重分支使用模拟接口回归。文章赞同与不同网站页面版本仍需要更多验证，详见已知问题。

MIT；来源与第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
