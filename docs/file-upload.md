# 文件上传

CUA 支持给标准 `input[type=file]` 设置文件，无需打开或操作系统文件选择器。

```js
await tab.locator('input[type=file]', { frameId }).setInputFiles('/absolute/path/cost-card.xlsx');
// multiple 文件控件
await tab.actions.setInputFiles(target, ['/absolute/a.csv', '/absolute/b.csv']);
// 清空已选文件
await tab.locator('input[type=file]', { frameId }).setInputFiles([]);
```

路径必须是 **CUA 服务进程所在机器**上的绝对路径；远程浏览器同样由服务读取文件并传递字节，不要求文件存在于浏览器主机。只传入用户授权上传的文件。单次最多 20 个普通文件、合计 50 MiB，不支持目录上传；文件扩展名用于常见 MIME 类型推断，其他类型使用 `application/octet-stream`。

支持 iframe、隐藏文件控件及元素引用。目标必须唯一、仍连接在当前文档中且未禁用；多文件要求 `multiple` 属性。上传前会再次校验目标及站点策略。文件内容不会作为 SDK 参数或结果返回，执行历史可记录调用代码中的路径。

设置文件会触发浏览器 `input` / `change` 事件，网站可能随即自动上传。成功仅代表完成选文件，不代表服务端导入成功。观察 `input.files` 和网站提示后，再决定预览、提交或重试。派发之后发生异常返回 `ACTION_OUTCOME_UNKNOWN`，不可盲目重放。

```js
output.json(await tab.evaluate(() =>
  Array.from(document.querySelector('input[type=file]').files)
    .map(file => ({ name: file.name, size: file.size, type: file.type })),
  undefined, { frameId }));
```

构建后需重新启动 MCP 服务进程以加载新实现；`cua_reset` 只重建 REPL，不会热更新正在运行的服务。
