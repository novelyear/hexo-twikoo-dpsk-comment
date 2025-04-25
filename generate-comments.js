// 导入必要的依赖模块
require('dotenv').config();
const { default: axios } = require('axios');
const crypto = require('crypto');
const fs = require('fs').promises;
const { existsSync } = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { MongoClient } = require('mongodb');

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
    postsDir: './source/_posts',
    dbPath: 'D:/blog/db.json'  // Hexo 的数据库文件路径
  },
  logging: {
    enabled: true,
    consoleOutput: true,
    fileOutput: false,
    logFile: './logs/app.log'
  },
  timeThreshold: {
    // 设置 1 分钟的更新时间阈值（单位：毫秒）
    updateInterval: 1 * 60 * 1000
  }
};

// 日志工具函数
class Logger {
  constructor(options = config.logging) {
    this.enabled = options.enabled;
    this.consoleOutput = options.consoleOutput;
    this.fileOutput = options.fileOutput;
    this.logFile = options.logFile;
  }

  async log(message, type = 'INFO') {
    if (!this.enabled) return;

    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${type}] ${message}`;

    if (this.consoleOutput) {
      console.log(logMessage);
    }

    if (this.fileOutput && this.logFile) {
      await fs.appendFile(this.logFile, logMessage + '\n').catch(() => {});
    }
  }

  async error(message) {
    await this.log(message, 'ERROR');
  }
}

const logger = new Logger();

// 数据库连接管理器
class DbManager {
  constructor(uri, dbName) {
    this.uri = uri;
    this.dbName = dbName;
    this.client = null;
    this.db = null;
  }

  async connect() {
    if (!this.client) {
      this.client = new MongoClient(this.uri);
      await this.client.connect();
      this.db = this.client.db(this.dbName);
      await logger.log('数据库连接已建立');
    }
    return this.db;
  }

  async close() {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      await logger.log('数据库连接已关闭');
    }
  }

  getCollection(name) {
    if (!this.db) {
      throw new Error('数据库未连接');
    }
    return this.db.collection(name);
  }
}

// 创建全局数据库管理器实例
const dbManager = new DbManager(config.mongodb.uri, config.mongodb.dbName);

// 获取文章的 UTC 日期路径
function getUtcDatePath(date) {
  const utcDate = new Date(date);
  return {
    year: utcDate.getUTCFullYear(),
    month: String(utcDate.getUTCMonth() + 1).padStart(2, '0'),
    day: String(utcDate.getUTCDate()).padStart(2, '0')
  };
}

// 编码 URL 中的中文字符
function encodeUrlPath(path) {
  return path.split('/').map(part => {
    return /[\u4e00-\u9fa5]/.test(part) ? encodeURIComponent(part) : part;
  }).join('/');
}

// 使用 DeepSeek API 生成文章摘要
async function getSummary(content) {
  await logger.log('开始生成文章摘要...');
  try {
    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是一个博客读者，擅长阅读并总结博客文章。请以第三人称提供一段不超过100字的博客内容简洁总结。' },
          { role: 'user', content: content }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    await logger.error(`DeepSeek API error: ${error.response?.data || error.message}`);
    return null;
  }
}

// 检查指定文章是否已有机器人评论
async function hasExistingComment(encodedPostId, date) {
  const { year, month, day } = getUtcDatePath(date);
  const urlPath = `/${year}/${month}/${day}/${encodedPostId}/`;
  
  try {
    const collection = dbManager.getCollection(config.mongodb.collection);
    const count = await collection.countDocuments({
      url: urlPath,
      nick: config.deepseek.botName,
      rid: { $in: ['', null] },
      isSpam: { $ne: true }
    });
    return count > 0;
  } catch (error) {
    await logger.error(`检查评论失败: ${error.message}`);
    return false;
  }
}

// 发布评论到文章
async function postComment(content, postId, date) {
  await logger.log(`开始为文章 ${postId} 发布评论`);
  
  const { year, month, day } = getUtcDatePath(date);
  const encodedPostId = encodeUrlPath(postId);
  const urlPath = `/${year}/${month}/${day}/${encodedPostId}/`;
  const hrefPath = `https://newyann.com${urlPath}`;
  
  try {
    const collection = dbManager.getCollection(config.mongodb.collection);
    const commentDo = {
      _id: crypto.randomBytes(16).toString('hex'),
      uid: config.deepseek.botUid,
      nick: config.deepseek.botName,
      mail: '',
      mailMd5: '',
      link: config.deepseek.botLink,
      ua: config.deepseek.botUa,
      ip: '127.0.0.1',
      master: false,
      url: urlPath,
      href: hrefPath,
      comment: `<p>${content}</p>`,
      pid: null,
      rid: null,
      isSpam: false,
      created: new Date(),
      updated: new Date()
    };

    await collection.insertOne(commentDo);
    await logger.log(`评论发布成功: ${postId}`);
    return true;
  } catch (error) {
    await logger.error(`Post comment error for ${postId}: ${error.message}`);
    return null;
  }
}

// 更新评论
async function updateComment(postId, date, content) {
  await logger.log(`开始更新文章 ${postId} 的评论`);
  
  const { year, month, day } = getUtcDatePath(date);
  const encodedPostId = encodeUrlPath(postId);
  const urlPath = `/${year}/${month}/${day}/${encodedPostId}/`;
  
  try {
    const collection = dbManager.getCollection(config.mongodb.collection);
    const updatedComment = {
      comment: `<p>${content}</p>`,
      updated: new Date()
    };

    await collection.updateOne({ url: urlPath, nick: config.deepseek.botName }, { $set: updatedComment });
    await logger.log(`评论更新成功: ${postId}`);
    return true;
  } catch (error) {
    await logger.error(`Update comment error for ${postId}: ${error.message}`);
    return null;
  }
}

// 添加更新文章 frontmatter 的函数
async function updatePostExcerpt(post, summary) {
  try {
    const postPath = post.full_source;
    const content = await fs.readFile(postPath, 'utf8');
    const { data, content: postContent } = matter(content);
    
    // 更新 frontmatter
    data.excerpt = summary;
    
    // 重新组装文章内容
    const updatedContent = matter.stringify(postContent, data);
    await fs.writeFile(postPath, updatedContent);
    
    await logger.log(`更新文章摘要成功: ${post.title}`);
    return true;
  } catch (error) {
    await logger.error(`更新文章摘要失败: ${error.message}`);
    return false;
  }
}

// 添加读取 Hexo 数据库的函数
async function loadHexoDb() {
  try {
    const data = await fs.readFile(config.hexo.dbPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    await logger.error(`读取 db.json 失败: ${error.message}`);
    return null;
  }
}

// 修改主程序入口，接入 Hexo
hexo.extend.filter.register('before_generate', async function() {
  const log = this.log || console;
  log.info('DeepSeek Comments: 开始处理评论...');
  
  try {
    await dbManager.connect();
    
    // 读取 Hexo 数据库
    const hexoDb = await loadHexoDb();
    if (!hexoDb || !hexoDb.models || !hexoDb.models.Post) {
      throw new Error('无法读取 Hexo 数据库');
    }

    // 获取所有文章
    const posts = this.locals.get('posts').data;
    const collection = dbManager.getCollection(config.mongodb.collection);
    
    // 从 db.json 创建文章映射表
    const postMap = new Map(
      hexoDb.models.Post.map(post => [post._id, post])
    );
    
    // 获取所有已有的 DeepSeek 评论
    const existingComments = await collection.find({
      nick: config.deepseek.botName
    }).toArray();
    
    const commentMap = new Map(
      existingComments.map(comment => [comment.url, comment])
    );
    
    // 处理当前文章
    let processedCount = 0;
    let skippedCount = 0;
    let updatedCount = 0;
    
    for (const post of posts) {
      if (post.draft) {
        skippedCount++;
        continue;
      }
      
      const postTitle = post.title || '无标题';
      const postId = post.slug || path.basename(post.source, '.md');
      const { year, month, day } = getUtcDatePath(new Date(post.date));
      const encodedPostId = encodeUrlPath(postId);
      const urlPath = `/${year}/${month}/${day}/${encodedPostId}/`;
      
      // 从 Hexo 数据库中获取文章数据
      const hexoPost = postMap.get(post._id);
      if (!hexoPost) {
        log.warn(`找不到文章的数据库记录: ${postTitle}`);
        skippedCount++;
        continue;
      }
      
      log.info(`处理文章: ${postTitle} (修改时间: ${hexoPost.updated})`);
      
      const existingComment = commentMap.get(urlPath);
      
      // 使用 Hexo 的 updated 字段判断文章是否更新
      if (existingComment) {
        const commentDate = new Date(existingComment.updated);
        const modifiedDate = new Date(hexoPost.updated);
        
        // 计算时间差（毫秒）
        const timeDiff = Math.abs(modifiedDate - commentDate);
        
        // 如果文章更新时间晚于评论时间，且时间差大于阈值，则更新评论
        if (modifiedDate > commentDate && timeDiff > config.timeThreshold.updateInterval) {
          log.info(`更新评论: ${postTitle} (修改时间: ${modifiedDate}, 评论时间: ${commentDate}, 时间差: ${Math.round(timeDiff/1000)}秒)`);
          const newSummary = await getSummary(post._content);
          if (!newSummary) {
            skippedCount++;
            continue;
          }
          
          // 更新评论和文章摘要
          await Promise.all([
            updateComment(postId, new Date(post.date), newSummary),
            updatePostExcerpt(post, newSummary)
          ]);
          
          updatedCount++;
          log.info(`更新文章评论和摘要: ${postTitle}`);
        } else {
          skippedCount++;
          if (timeDiff <= config.timeThreshold.updateInterval) {
            log.info(`跳过文章: ${postTitle} (时间差小于${config.timeThreshold.updateInterval/1000}秒)`);
          } else {
            log.info(`跳过文章: ${postTitle} (内容未变化)`);
          }
        }
      } else {
        // 新文章，添加评论
        const summary = await getSummary(post._content);
        if (!summary) {
          skippedCount++;
          continue;
        }
        
        // 添加评论和更新文章摘要
        await Promise.all([
          postComment(summary, postId, new Date(post.date)),
          updatePostExcerpt(post, summary)
        ]);
        
        processedCount++;
        log.info(`添加新评论和摘要: ${postTitle}`);
      }
    }
    
    // 清理不存在文章的评论
    const currentUrls = new Set(posts.map(post => {
      const { year, month, day } = getUtcDatePath(new Date(post.date));
      const encodedPostId = encodeUrlPath(post.slug || path.basename(post.source, '.md'));
      return `/${year}/${month}/${day}/${encodedPostId}/`;
    }));
    
    for (const [url, comment] of commentMap) {
      if (!currentUrls.has(url)) {
        await collection.deleteOne({ _id: comment._id });
        log.info(`删除已移除文章的评论: ${url}`);
      }
    }
    
    log.info('DeepSeek Comments: 处理完成');
    log.info(`总文章数: ${posts.length}`);
    log.info(`处理成功: ${processedCount}`);
    log.info(`跳过文章: ${skippedCount}`);
    log.info(`更新评论: ${updatedCount}`);
    
  } catch (error) {
    log.error('DeepSeek Comments 错误:', error.message);
    console.error(error);
  } finally {
    await dbManager.close();
  }
});

// 导出主要函数供其他模块使用
module.exports = {
  getSummary,
  postComment,
  updateComment
};