# Hexo脚本：利用DeepSeek生成总结性评论并作为文章摘要

效果示例：[novelyear&#39;s home](https://www.newyann.com/)

**适用范围：hexo博客、twikoo评论插件(至少json格式与twikoo一致)、MongoDB数据库**

# 使用方法

1. 下载 `generate-comments.js`
2. 将 `generate-comments.js`放在博客目录的 `/scripts`下
3. 在博客根目录下创建 `.env` 文件：包含 `MONGODB_URI=你的MongoDB连接串` + `DEEPSEEK_API_KEY=你的API密钥`
4. 在博客根目录的 `package.json`的 `dependencies`下增加：

   ```json
   "axios": "^1.6.0",
   "dotenv": "^16.5.0",
   "gray-matter": "^4.0.3",
   "mongodb": "^6.0.0"
   ```
5. 在博客根目录下打开终端(git bash之类的)，运行 `npm install`下载依赖
6. 在 `generate-comments.js`中修改配置（见下）
7. `hexo g`即可运行脚本

> 获取MongoDB连接串的方式见：[MongoDB Atlas | Twikoo 文档](https://twikoo.js.org/mongodb-atlas.html)
>
> 获取DEEPSEEK_API_KEY的方式见：[DeepSeek 开放平台](https://platform.deepseek.com/api_keys)

---

在代码开头有配置项：

```javascript
// 配置项
const config = {
  deepseek: {
    botName: 'DeepSeek',
    botUid: 'deepseek-bot',
    botLink: 'https://www.deepseek.com/',
    botUa: 'DeepSeek Bot/1.0'
  },
  mongodb: {
    uri: process.env.MONGODB_URI,
    dbName: 'test',
    collection: 'comment'
  },
  hexo: {
    postsDir: './source/_posts'
  },
  logging: {
    enabled: true,
    consoleOutput: true,
    fileOutput: false,
    logFile: './logs/app.log'
  }
};
```

**根据自己的实际情况修改配置：**

- `deepseek`下面的配置是设置评论区的AI评论的相关信息，并非使用V1还是R1，要修改模型调用就Ctrl+F搜索v1，改成R1对应的URL即可，换用其他大模型同理
- `mongodb`下的配置是连接数据库相关的信息，`dbname`是数据库名称，`collection`是数据库内存评论的库
- `hexo`下的配置是存放博文的相对路径
- `logging`下的配置是是否在运行时启用日志功能，`enabled`表示启用，`consoleOutput`表示在命令行中打印日志输出，`fileOutput`表示输出日志到文件中，`logFile`表示日志存储文件的路径

# limitation

- 仅适用于使用MongoDB，最好是twikoo的hexo博客
- 目前只支持DeepSeek，其他的需要修改API_KEY和相应配置
- DeepSeek API要花钱
- 使用教程可能有问题，自己成功了，但是没重新测试(lll￢ω￢)
