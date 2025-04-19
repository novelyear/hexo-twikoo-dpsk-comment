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
    postsDir: './source/_posts'
  },
  logging: {
    enabled: true,
    consoleOutput: true,
    fileOutput: false,
    logFile: './logs/app.log'
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

// 修改主程序入口，接入 Hexo
hexo.extend.filter.register('after_generate', async function() {
  const log = this.log || console;
  log.info('DeepSeek Comments: 开始处理评论...');
  
  try {
    // 建立数据库连接
    await dbManager.connect();
    
    // 获取所有文章并过滤掉草稿
    const posts = this.locals.get('posts').data
      .filter(post => !post.draft);
    
    log.info(`找到 ${posts.length} 篇文章`);
    
    let processedCount = 0;
    let skippedCount = 0;
    
    for (const post of posts) {
      // 使用 post.title 作为日志标识
      const postTitle = post.title || '无标题';
      const postId = post.slug || path.basename(post.source, '.md');
      const encodedPostId = encodeUrlPath(postId);
      
      log.info(`处理文章: ${postTitle} (${postId})`);
      
      // 检查是否已有评论
      if (await hasExistingComment(encodedPostId, new Date(post.date))) {
        skippedCount++;
        log.info(`跳过文章: ${postTitle} (已有评论)`);
        continue;
      }
      
      // 使用 post._content 获取原始内容
      const summary = await getSummary(post._content || post.raw || post.content);
      if (!summary) {
        skippedCount++;
        log.warn(`跳过文章: ${postTitle} (生成摘要失败)`);
        continue;
      }
      
      // 发布评论
      await postComment(summary, postId, new Date(post.date));
      processedCount++;
      log.info(`处理完成: ${postTitle}`);
    }
    
    log.info('DeepSeek Comments: 处理完成');
    log.info(`总文章数: ${posts.length}`);
    log.info(`处理成功: ${processedCount}`);
    log.info(`跳过文章: ${skippedCount}`);
    
  } catch (error) {
    log.error('DeepSeek Comments 错误:', error.message);
    // 打印更详细的错误信息
    console.error(error);
  } finally {
    // 关闭数据库连接
    await dbManager.close();
  }
});

// 导出主要函数供其他模块使用
module.exports = {
  getSummary,
  postComment
};