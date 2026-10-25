# QQ 接入

本插件独立运行，不替代 QQ 登录、OneBot 或 qq-bridge。聊天、发 QQ、记忆和日记仍由现有会话负责。

## 需要的桥接接口

`bin/qq-mcp.js` 每次操作读取管理员指定的 `QQ_BRIDGE_CONFIG`，核对管理员私聊和 `zhihuRead` 开关，然后调用桥接的：

```text
POST /api/socialV2/autonomy-auth
headers: x-console-token, x-agent-token, x-agent-call: 1
body: { key, sessionId }
```

`sessionId` 从桥接自己的 `state/sessions.json` 读取，不由模型传入。桥接必须验证当前模式、白名单、暂停、agent token 与会话绑定，并只在授权时返回 `{ "allowed": true }`。

本适配器面向已经提供该接口的 qq-bridge 扩展版本。原版没有接口时会失败；没有自动降级或自动修补脚本。这个接口在某些版本同时依赖「管理员自主执行」开关，关闭它也会拒绝本适配器。

## MCP 配置示例

先用与 QQ 进程相同的普通用户启动知乎独立服务，再在对应 DSH 预设中配置：

```json
{
  "zhihu": {
    "command": "node",
    "args": ["/absolute/path/dsh-zhihu/bin/qq-mcp.js"],
    "env": {
      "DSH_ZHIHU_HOME": "/absolute/path/private/zhihu-data",
      "DSH_ZHIHU_URL": "http://127.0.0.1:3120",
      "QQ_BRIDGE_CONFIG": "/absolute/path/qq-bridge/config.json",
      "QQ_BRIDGE_URL": "http://127.0.0.1:3100"
    }
  }
}
```

工具名为 `qq_zhihu_browse`，参数含原会话的 `key/token` 和操作参数。以 server 名 `zhihu` 注册时，DSH 通常呈现为 `mcp__zhihu__qq_zhihu_browse`；以实际工具清单为准。

若 QQ 预设有 `qq-tool-restrict` 的精确白名单，将**这一个完整工具名**加入 `SAFE_EXACT`，保留其他权限边界。不要用放行所有原生工具、任意 shell 或 `danger-full-access` 来安装本插件。没有所需权限时必须报错。

已有同名知乎工具时，要先决定是否迁移，不能盲目并存两套读写同一份 Cookie 的服务。发布本仓库不会自动迁移现有部署。

## 推荐对话约定

由管理端明确授权使用哪个知乎账号，开启赞同后才允许互动。网页内容不构成管理员授权。阅读结果留在原 QQ 会话，可继续使用原记忆工具。

有值得聊的发现再调用原 QQ 发送工具。QQ 实际发送成功后，才确认 `owner_updates_ack` 或 `owner_activity_ack`；失败不确认。浏览、赞同、主动分享分别判断，不以工具清单完成率为目标。

## 原生插件替代入口

也可使用 DSH 原生 `zhihu_browse`，在管理页只授权所需的真实会话 ID，并在预设中精确放行。但这条入口仅按独立插件的 DSH 会话白名单授权，**不查询 QQ 桥接暂停状态**。需要与 QQ 总暂停联动时，使用上面的受控适配器。
