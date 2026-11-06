/**
 * 挂载管理器
 * 负责管理存储驱动实例的创建、缓存和生命周期
 * 基于挂载点配置动态创建和管理存储驱动
 *
 */

import { StorageFactory } from "../factory/StorageFactory.js";
import { ApiStatus } from "../../constants/index.js";
import { AppError, AuthorizationError, DriverError, NotFoundError, ValidationError } from "../../http/errors.js";
import { findMountPointByPath } from "../fs/utils/MountResolver.js";
import { StorageConfigUtils } from "../utils/StorageConfigUtils.js";
import { getAccessibleMountsForUser } from "../../security/helpers/access.js";
import { ensureRepositoryFactory } from "../../utils/repositories.js";
import { UserType } from "../../constants/index.js";

// MountManager 的权限触点只剩 `_validateMountPermissionForApiKey`，
// 它依赖 security/access 的工具保证 basicPath + S3 公共性一致，
// 因而这里不再直接引用任何 authGateway 逻辑。

// 全局驱动缓存 - 永不过期策略，配置更新时主动清理
const globalDriverCache = new Map();
const MAX_CACHE_SIZE = 12;
// 调试开关默认值（当 env / process.env 都没配置时生效）
const DEFAULT_DEBUG_DRIVER_CACHE = false;

// 缓存统计
const cacheStats = {
  hits: 0,
  misses: 0,
  errors: 0,
  cleanups: 0,
};

function toMountAppError(errorInfo) {
  const status = errorInfo?.status ?? ApiStatus.INTERNAL_ERROR;
  const message = errorInfo?.message ?? "挂载点解析失败";
  switch (status) {
    case ApiStatus.BAD_REQUEST:
      return new ValidationError(message);
    case ApiStatus.FORBIDDEN:
      return new AuthorizationError(message);
    case ApiStatus.NOT_FOUND:
      return new NotFoundError(message);
    default:
      return new AppError(message, { status, code: "MOUNT_RESOLVE_FAILED", expose: status < 500 });
  }
}

/**
 * 清理所有驱动缓存（手动清理用）
 * 由于采用永不过期策略，此函数主要用于手动清理或调试
 */
function cleanupExpiredDrivers() {
  // 永不过期策略下，此函数主要用于手动清理
  // 实际的清理通过配置更新时的主动清理完成
  console.log(`当前驱动缓存数量: ${globalDriverCache.size}，采用永不过期 + 主动清理策略`);
  return 0;
}

/**
 * LRU清理：当缓存数量超过限制时，清理最久未访问的项
 * @param {number} targetSize - 目标缓存大小
 */
function evictOldestEntries(targetSize = MAX_CACHE_SIZE * 0.8) {
  if (globalDriverCache.size <= targetSize) return 0;

  // 按最后访问时间排序，找出最久未访问的项
  const entries = Array.from(globalDriverCache.entries()).sort(([, a], [, b]) => {
    const aTime = a.lastAccessed || a.timestamp;
    const bTime = b.lastAccessed || b.timestamp;
    return aTime - bTime;
  });

  const toRemove = globalDriverCache.size - targetSize;
  let removedCount = 0;

  for (let i = 0; i < toRemove && i < entries.length; i++) {
    const [key, cached] = entries[i];
    try {
      cached.driver.cleanup?.();
    } catch (error) {
      console.warn(`LRU清理驱动失败 ${key}:`, error.message);
    }
    globalDriverCache.delete(key);
    removedCount++;
  }

  if (removedCount > 0) {
    console.log(`🗑️ LRU清理了 ${removedCount} 个最久未访问的驱动缓存`);
  }

  return removedCount;
}

export class MountManager {
  /**
   * 统一解析 DEBUG_DRIVER_CACHE
   *
   * - 未配置（undefined/null/空字符串） -> 使用 defaultValue
   * - 配置了 -> 仅当值为 "true" 时返回 true，否则返回 false
   */
  static resolveDebugDriverCache({ env = null, defaultValue = DEFAULT_DEBUG_DRIVER_CACHE } = {}) {
    const raw =
      env?.DEBUG_DRIVER_CACHE ??
      (typeof process !== "undefined" ? process.env?.DEBUG_DRIVER_CACHE : null);

    if (raw == null || String(raw).trim() === "") {
      return !!defaultValue;
    }

    return String(raw).trim().toLowerCase() === "true";
  }

  /**
   * 构造函数
   * @param {D1Database} db - 数据库实例
   * @param {string} encryptionSecret - 加密密钥
   */
  constructor(db, encryptionSecret, repositoryFactory = null, options = {}) {
    this.db = db;
    this.encryptionSecret = encryptionSecret;
    this.repositoryFactory = ensureRepositoryFactory(db, repositoryFactory);
    // 运行时环境：FileSystem / 索引层需要它推导数据库方言（DB_PROVIDER / DB_DIALECT）
    this.env = options?.env ?? null;

    // 调试开关：驱动缓存日志
    // 只认 true/false（不区分大小写）
    const envEnabled = MountManager.resolveDebugDriverCache({ env: options?.env, defaultValue: DEFAULT_DEBUG_DRIVER_CACHE });
    this.debugDriverCache = typeof options?.debugDriverCache === "boolean" ? options.debugDriverCache : envEnabled;

    // 记录管理器创建时间，用于统计
    this.createdAt = Date.now();
  }

  /**
   * 根据路径获取存储驱动
   * @param {string} path - 文件路径
   * @param {string|Object} userIdOrInfo - 用户ID或API密钥信息
   * @param {string} userType - 用户类型
   * @returns {Promise<Object>} 包含驱动实例和挂载信息的对象
   */
  async getDriverByPath(path, userIdOrInfo, userType) {
    // 查找挂载点
    const mountResult = await findMountPointByPath(this.db, path, userIdOrInfo, userType, this.repositoryFactory);

    if (mountResult.error) {
      throw toMountAppError(mountResult.error);
    }

    const { mount, subPath } = mountResult;

    // 对API密钥用户验证挂载点S3配置权限
    if (userType === UserType.API_KEY) {
      await this._validateMountPermissionForApiKey(mount, userIdOrInfo);
    }

    // 获取存储驱动
    const driver = await this.getDriver(mount);

    return {
      driver,
      mount,
      subPath,
      mountPath: mountResult.mountPath,
    };
  }

  /**
   * 根据挂载点获取存储驱动
   * @param {Object} mount - 挂载点对象
   * @returns {Promise<any>} 存储驱动实例（BaseDriver 子类）
   */
  async getDriver(mount) {
    // 如果缓存数量超过限制，进行LRU清理
    if (globalDriverCache.size >= MAX_CACHE_SIZE) {
      evictOldestEntries();
    }

    const cacheKey = `${mount.storage_type}:${mount.storage_config_id}`;
    const cached = globalDriverCache.get(cacheKey);

    // 检查缓存有效性和健康状态（永不过期，只检查健康状态）
    if (cached) {
      try {
        // 轻量级健康检查
        if (cached.driver.isInitialized()) {
          cacheStats.hits++;
          // 更新访问时间（用于LRU）
          cached.lastAccessed = Date.now();
          const cacheAge = Math.round((Date.now() - cached.timestamp) / 1000 / 60);
          if (this.debugDriverCache) {
            console.log(`✅[MountManager]驱动缓存命中: ${cacheKey} (缓存年龄: ${cacheAge}分钟)`);
          }
          return cached.driver;
        }
      } catch (error) {
        cacheStats.errors++;
        globalDriverCache.delete(cacheKey);
      }
    }

    // 缓存未命中，创建新驱动
    cacheStats.misses++;
    const driver = await this._createDriverWithRetry(mount);

    // 缓存新创建的驱动
    globalDriverCache.set(cacheKey, {
      driver,
      timestamp: Date.now(),
      lastAccessed: Date.now(),
      mountId: mount.id,
      storageType: mount.storage_type,
    });

    if (this.debugDriverCache) {
      console.log(`🆕[MountManager]创建新驱动: ${cacheKey} (当前缓存数量: ${globalDriverCache.size})`);
    }
    return driver;
  }

  /**
   * 创建存储驱动实例（带重试机制）
   * @private
   * @param {Object} mount - 挂载点对象
   * @param {number} maxRetries - 最大重试次数
   * @returns {Promise<any>} 存储驱动实例（BaseDriver 子类）
   */
  async _createDriverWithRetry(mount, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await this._createDriver(mount);
      } catch (error) {
        const isLastAttempt = i === maxRetries - 1;
        if (isLastAttempt) {
          cacheStats.errors++;
          if (error instanceof AppError) {
            throw error;
          }
          throw new DriverError("存储驱动创建失败", {
            status: ApiStatus.INTERNAL_ERROR,
            expose: false,
            details: {
              cause: error?.message,
              storageType: mount?.storage_type,
              storageConfigId: mount?.storage_config_id,
            },
          });
        }

        // 指数退避：1秒、2秒、3秒
        const delay = 1000 * (i + 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * 创建存储驱动实例
   * @private
   * @param {Object} mount - 挂载点对象
   * @returns {Promise<any>} 存储驱动实例（BaseDriver 子类）
   */
  async _createDriver(mount) {
    // 获取存储配置
    const config = await this._getStorageConfig(mount);

    // 使用工厂创建驱动
    const driver = await StorageFactory.createDriver(mount.storage_type, config, this.encryptionSecret);

    return driver;
  }

  /**
   * 获取存储配置
   * @private
   * @param {Object} mount - 挂载点对象
   * @returns {Promise<Object>} 存储配置
   */
  async _getStorageConfig(mount) {
    return await StorageConfigUtils.getStorageConfig(this.db, mount.storage_type, mount.storage_config_id);
  }

  /**
   * 验证API密钥用户的挂载点权限
   * 检查挂载点的S3配置是否允许API密钥用户访问
   * @private
   * @param {Object} mount - 挂载点对象
   * @param {Object} userIdOrInfo - API密钥用户信息
   * @throws {AuthorizationError} 当权限不足时抛出异常
  */
  async _validateMountPermissionForApiKey(mount, userIdOrInfo) {
    try {
      // 获取可访问的挂载点列表（已包含S3配置权限过滤）
      const accessibleMounts = await getAccessibleMountsForUser(this.db, userIdOrInfo, UserType.API_KEY, this.repositoryFactory);

      // 验证目标挂载点是否在可访问列表中
      const isAccessible = accessibleMounts.some((accessibleMount) => accessibleMount.id === mount.id);

      if (!isAccessible) {
        console.log(`MountManager权限检查失败: API密钥用户无权限访问挂载点 ${mount.name}`);
        throw new AuthorizationError(`API密钥用户无权限访问挂载点: ${mount.name}`);
      }

      console.log(`MountManager权限检查通过: API密钥用户可访问挂载点 ${mount.name}`);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      console.error("MountManager权限检查过程发生错误:", error);
      throw new AppError("权限检查过程发生错误", {
        status: ApiStatus.INTERNAL_ERROR,
        code: "MOUNT_PERMISSION_CHECK_FAILED",
        expose: false,
        details: { cause: error?.message },
      });
    }
  }

  /**
   * 清理指定挂载点的驱动缓存
   * @param {string} mountId - 挂载点ID
   */
  async clearMountCache(mountId) {
    let clearedCount = 0;

    for (const [key, cached] of globalDriverCache.entries()) {
      if (cached.mountId === mountId) {
        try {
          await cached.driver.cleanup?.();
        } catch (error) {
          console.warn(`清理挂载点驱动失败 ${key}:`, error.message);
        }
        globalDriverCache.delete(key);
        clearedCount++;
      }
    }

    if (clearedCount > 0) {
      console.log(`清理挂载点驱动缓存: ${mountId} -> 清理了 ${clearedCount} 个驱动`);
    }
  }

  /**
   * 清理指定存储配置的驱动缓存
   * @param {string} storageType - 存储类型
   * @param {string} configId - 配置ID
   */
  async clearConfigCache(storageType, configId) {
    const cacheKey = `${storageType}:${configId}`;
    const cached = globalDriverCache.get(cacheKey);

    if (cached) {
      try {
        await cached.driver.cleanup?.();
      } catch (error) {
        console.warn(`清理存储配置驱动失败 ${cacheKey}:`, error.message);
      }
      globalDriverCache.delete(cacheKey);
      console.log(`清理存储配置驱动缓存: ${cacheKey}`);
    }
  }

  /**
   * 获取缓存统计信息
   * @returns {Object} 缓存统计信息
   */
  getCacheStats() {
    const totalRequests = cacheStats.hits + cacheStats.misses;
    const hitRate = totalRequests > 0 ? Math.round((cacheStats.hits / totalRequests) * 100) : 0;

    return {
      totalCached: globalDriverCache.size,
      maxCacheSize: MAX_CACHE_SIZE,
      hits: cacheStats.hits,
      misses: cacheStats.misses,
      errors: cacheStats.errors,
      cleanups: cacheStats.cleanups,
      hitRate: hitRate,
      cacheUtilization: Math.round((globalDriverCache.size / MAX_CACHE_SIZE) * 100),
      managerUptime: Math.round((Date.now() - this.createdAt) / 1000 / 60), // 分钟
    };
  }

  /**
   * 手动清理过期驱动缓存
   * @returns {number} 清理的驱动数量
   */
  manualCleanup() {
    const expiredCount = cleanupExpiredDrivers();
    const lruCount = evictOldestEntries();
    return expiredCount + lruCount;
  }

  /**
   * 清理所有驱动缓存
   */
  async clearAllCache() {
    const promises = [];
    let clearedCount = globalDriverCache.size;

    for (const [, cached] of globalDriverCache.entries()) {
      if (cached.driver?.cleanup) {
        promises.push(cached.driver.cleanup().catch(() => {}));
      }
    }

    await Promise.all(promises);
    globalDriverCache.clear();

    if (clearedCount > 0) {
      console.log(`已清理所有存储驱动缓存: ${clearedCount} 个驱动`);
    }
  }

  /**
   * 销毁管理器
   */
  async destroy() {
    // 清理所有缓存
    await this.clearAllCache();

    // 重置统计信息
    cacheStats.hits = 0;
    cacheStats.misses = 0;
    cacheStats.errors = 0;
    cacheStats.cleanups = 0;

    console.log("挂载管理器已销毁");
  }
}
