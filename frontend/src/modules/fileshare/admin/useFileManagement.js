import { ref, reactive, computed } from "vue";
import { useI18n } from "vue-i18n";
import { copyToClipboard } from "@/utils/clipboard.js";
import { useDeleteSettingsStore } from "@/stores/deleteSettingsStore.js";
import { useAdminBase } from "@/modules/admin";
import { generateQRCode as createQRCodeImage } from "@/utils/qrcodeUtils.js";
import { useFileshareService } from "@/modules/fileshare/fileshareService.js";
import { useFileShareStore } from "@/modules/fileshare/fileShareStore.js";
import { createLogger } from "@/utils/logger.js";

const log = createLogger("FileManagement");

/**
 * 文件管理专用composable
 * 基于useAdminBase，添加文件管理特有的逻辑
 * @param {string} userType - 用户类型 'admin' 或 'apikey'
 * @param {Object} options - 配置选项
 * @param {Function} options.confirmFn - 确认对话框函数（必需）
 */
export function useFileManagement(userType = "admin", { confirmFn } = {}) {
  if (!confirmFn) {
    throw new Error("useFileManagement 必须传入 confirmFn（请在 View 里用 useConfirmDialog + createConfirmFn 创建）");
  }
  // 继承基础管理功能
  const base = useAdminBase("file-management");

  // 国际化
  const { t } = useI18n();

  const fileshareService = useFileshareService();
  const fileShareStore = useFileShareStore();
  // 文件管理特有状态（列表统一由 fileshare store 提供）
  const files = computed(() => fileShareStore.items);
  const editingFile = ref(null);
  const previewFile = ref(null);
  const showEdit = ref(false);
  const showPreview = ref(false);
  const showQRCodeModal = ref(false);
  const qrCodeDataURL = ref("");
  const qrCodeSlug = ref("");

  // 删除设置store
  const deleteSettingsStore = useDeleteSettingsStore();

  // 用户类型判断
  const isAdmin = () => userType === "admin";
  const isApiKeyUser = () => userType === "apikey";

  // 搜索状态（服务端搜索）
  const searchQuery = ref("");
  const isSearchMode = ref(false);
  const searchLoading = ref(false);

  // 文件有效性检测（记录存在 ≠ 存储对象存在，需回到存储侧确认）
  // 结果只保存在当前视图，不写入 store，避免污染列表缓存
  const validityMap = reactive({});
  const verifying = ref(false);

  // 分片参数：单次请求受后端并发上限与默认 30s 超时约束，
  // 片内条数 × 单条最坏耗时必须留足余量，否则慢存储上整片会被掐断
  const VERIFY_CHUNK_SIZE = 50;
  const VERIFY_CHUNK_TIMEOUT_MS = 90000;

  // 检测进度（分片循环里更新，供按钮与提示展示）
  const verifyProgress = reactive({ done: 0, total: 0 });
  // 最近一次汇总，便于 UI 展示数量与「选择失效文件」的可用性
  const lastVerifySummary = ref(null);

  const clearValidity = () => {
    for (const key of Object.keys(validityMap)) {
      delete validityMap[key];
    }
    verifyProgress.done = 0;
    verifyProgress.total = 0;
    lastVerifySummary.value = null;
  };

  const getValidityState = (fileId) => validityMap[fileId] || null;

  /**
   * 当前页检测出的失效文件数（对象缺失 / 记录缺失）
   * 供「选择失效文件」按钮的文案使用
   */
  const invalidFileCount = computed(
    () =>
      (files.value || []).filter((file) => {
        const state = validityMap[file.id];
        return state && (state.status === "missing_object" || state.status === "missing_record");
      }).length
  );

  /**
   * 检测范围内（可能跨页）的失效总数
   * 按钮禁用态看它：跨页失效时也应允许点击，再由提示说明需翻页
   */
  const invalidTotalCount = computed(
    () =>
      Object.keys(validityMap).filter((id) => {
        const state = validityMap[id];
        return state && (state.status === "missing_object" || state.status === "missing_record");
      }).length
  );

  /**
   * 加载文件列表
   */
  const loadFiles = async () => {
    return await base.withLoading(async () => {
      try {
        const { pagination } = await fileShareStore.loadList({
          limit: base.pagination.limit,
          offset: base.pagination.offset,
        });
        base.updatePagination(pagination, "offset");
        base.updateLastRefreshTime();
        // 列表重新加载后旧的检测结果可能已失效，避免展示过期结论
        clearValidity();
      } catch (error) {
        log.error("加载文件列表失败:", error);
        base.showError(error.message || "加载数据失败");
        fileShareStore.resetState();
      }
    });
  };

  /**
   * 处理分页变化
   */
  const handleOffsetChange = (newOffset) => {
    base.handlePaginationChange(newOffset, "offset");
    loadFiles();
  };

  /**
   * 删除单个文件
   */
  const handleFileDelete = async (file) => {
    const confirmed = await confirmFn({
      title: t("common.dialogs.deleteTitle"),
      message: t("common.dialogs.deleteItem", { name: `"${file.filename}"` }),
      confirmType: "danger",
    });

    if (!confirmed) {
      return;
    }

    return await base.withLoading(async () => {
      await fileshareService.deleteFiles([file.id], deleteSettingsStore.getDeleteMode());
      base.showSuccess("删除成功");
      fileShareStore.removeFromStore(file.id);
      await loadFiles();
    });
  };

  /**
   * 批量删除文件
   */
  const handleBatchDelete = async () => {
    const selectedCount = base.selectedItems.value.length;
    if (selectedCount === 0) {
      base.showError("请先选择要删除的文件");
      return;
    }

    const confirmed = await confirmFn({
      title: t("common.dialogs.deleteTitle"),
      message: t("common.dialogs.deleteMultiple", { count: selectedCount }),
      confirmType: "danger",
    });

    if (!confirmed) {
      return;
    }

    return await base.withLoading(async () => {
      try {
        const result = await fileshareService.deleteFiles(base.selectedItems.value, deleteSettingsStore.getDeleteMode());

        if (result?.data && Array.isArray(result.data.failed) && result.data.failed.length > 0) {
          const { success: successCount, failed } = result.data;
          const failedCount = failed.length;
          base.showSuccess(`批量删除完成：成功 ${successCount} 个，失败 ${failedCount} 个`);

          const failedDetails = failed.map((item) => `ID: ${item.id} - ${item.error}`).join("\n");
          log.warn("部分文件删除失败:", failedDetails);
        } else if (result?.data && typeof result.data.success === "number") {
          base.showSuccess(`成功删除 ${result.data.success} 个文件`);
        } else {
          base.showSuccess(`成功删除 ${selectedCount} 个文件`);
        }
      } finally {
        base.clearSelection();
        await loadFiles();
      }
    });
  };

  /**
   * 检测文件有效性（回到存储侧确认对象是否仍存在）
   * - 有选中项则只检测选中项，否则检测当前页全部
   * - 分片提交，每片独立超时：单请求超时上限由后端并发数决定，
   *   片内条数受控才不会因为一个慢存储把整批拖到请求超时
   * - 结果写入 validityMap，供表格状态列展示
   */
  const handleVerifyFiles = async () => {
    if (verifying.value) return;

    const selected = base.selectedItems.value || [];
    const targets = selected.length > 0 ? selected : files.value.map((file) => file.id);

    if (!targets || targets.length === 0) {
      base.showError("当前没有可检测的文件");
      return;
    }

    verifying.value = true;
    verifyProgress.total = targets.length;
    verifyProgress.done = 0;

    const allResults = [];
    const failedChunks = [];
    let networkError = null;

    try {
      for (let start = 0; start < targets.length; start += VERIFY_CHUNK_SIZE) {
        const chunk = targets.slice(start, start + VERIFY_CHUNK_SIZE);
        try {
          const data = await fileshareService.verifyFiles(chunk, { timeout: VERIFY_CHUNK_TIMEOUT_MS });
          const results = Array.isArray(data?.results) ? data.results : [];
          allResults.push(...results);
        } catch (error) {
          // 单片失败不终止整批：记录失败 ID，按“无法判定”处理，不谎报文件丢失
          networkError = error;
          failedChunks.push({ ids: chunk, message: error?.message || "检测请求失败" });
          log.error(`检测分片失败（${chunk.length} 个）:`, error);
        } finally {
          verifyProgress.done = Math.min(verifyProgress.done + chunk.length, targets.length);
        }
      }

      for (const item of allResults) {
        if (!item?.id) continue;
        validityMap[item.id] = {
          status: item.status,
          message: item.message || null,
          sizeMismatch: item.size_mismatch === true,
          storageSize: item.storage_size ?? null,
          checkedAt: Date.now(),
        };
      }

      for (const failed of failedChunks) {
        for (const id of failed.ids) {
          validityMap[id] = {
            status: "error",
            message: failed.message,
            sizeMismatch: false,
            storageSize: null,
            checkedAt: Date.now(),
          };
        }
      }

      const summary = {
        total: allResults.length + failedChunks.reduce((sum, item) => sum + item.ids.length, 0),
        valid: allResults.filter((r) => r.status === "valid").length,
        invalid: allResults.filter((r) => r.status === "missing_object" || r.status === "missing_record").length,
        expired: allResults.filter((r) => r.status === "expired").length,
        error: allResults.filter((r) => r.status === "error").length + failedChunks.reduce((sum, item) => sum + item.ids.length, 0),
      };
      lastVerifySummary.value = summary;

      const invalidCount = summary.invalid + summary.expired;
      if (invalidCount > 0) {
        base.showError(
          `检测完成：正常 ${summary.valid} 个，失效/过期 ${invalidCount} 个，异常 ${summary.error} 个${
            summary.invalid > 0 ? "（可用「选择失效文件」一键勾选）" : ""
          }`
        );
      } else if (summary.error > 0) {
        base.showError(`检测完成：正常 ${summary.valid} 个，异常 ${summary.error} 个（存储不可达，无法判定）`);
      } else {
        base.showSuccess(`检测完成：${summary.valid || targets.length} 个文件均有效`);
      }

      log.info("文件有效性检测完成:", summary);
      if (networkError && failedChunks.length > 0) {
        log.warn("部分分片检测失败:", failedChunks.map((item) => item.message).join("; "));
      }
    } catch (error) {
      log.error("检测文件有效性失败:", error);
      base.showError(error.message || "检测文件有效性失败");
    } finally {
      verifying.value = false;
      verifyProgress.done = 0;
      verifyProgress.total = 0;
    }
  };

  /**
   * 一键选择失效文件
   * - 只勾选当前页里状态为「对象缺失 / 记录缺失」的文件（勾选态只对当前页可见，跨页勾选无意义）
   * - 已过期是记录层限制而非对象丢失，单独统计，避免误删仍可恢复的对象
   * @returns {number} 本次选中的文件数量
   */
  const selectInvalidFiles = () => {
    const invalidIds = files.value
      .filter((file) => {
        const state = validityMap[file.id];
        return state && (state.status === "missing_object" || state.status === "missing_record");
      })
      .map((file) => file.id);

    if (invalidIds.length === 0) {
      const otherPages = Object.keys(validityMap).filter((id) => {
        const state = validityMap[id];
        return state && (state.status === "missing_object" || state.status === "missing_record");
      }).length;
      base.showError(
        otherPages > 0
          ? `当前页没有失效文件；检测结果中另有 ${otherPages} 个失效文件在其他页，请翻页后再选择`
          : "当前页没有检测出的失效文件"
      );
      return 0;
    }

    // 统计检测范围内全部失效数，提示跨页未勾选的部分，避免误以为已全选
    const totalInvalid = Object.keys(validityMap).filter((id) => {
      const state = validityMap[id];
      return state && (state.status === "missing_object" || state.status === "missing_record");
    }).length;

    base.clearSelection();
    base.selectedItems.value = invalidIds;
    if (totalInvalid > invalidIds.length) {
      base.showSuccess(
        `已选择当前页 ${invalidIds.length} 个失效文件；另有 ${totalInvalid - invalidIds.length} 个在其他页，翻页后可再次选择`
      );
    } else {
      base.showSuccess(`已选择 ${invalidIds.length} 个失效文件，可继续批量删除`);
    }
    return invalidIds.length;
  };

  /**
   * 打开编辑弹窗
   */
  const openEditModal = async (file) => {
    try {
      const detail = await fileShareStore.fetchById(file.id, { useCache: false });
      editingFile.value = detail;
      showEdit.value = true;
    } catch (err) {
      log.error("获取文件详情失败:", err);
      base.showError(err.message || "获取文件详情失败，请稍后重试");
    }
  };

/**
   * 更新文件元数据
   */
  const updateFileMetadata = async (updatedFile) => {
    return await base.withLoading(async () => {
      try {
        await fileshareService.updateFileMetadata(updatedFile.id, updatedFile);
        base.showSuccess("文件信息更新成功");
        showEdit.value = false;
        editingFile.value = null;
        await loadFiles();
      } catch (err) {
        log.error("更新文件信息失败:", err);
        base.showError(err.message || "更新失败");
      }
    });
  };

  /**
   * 打开预览弹窗
   */
  const openPreviewModal = async (file) => {
    try {
      const detail = await fileShareStore.fetchById(file.id, { useCache: false, includeLinks: true });
      previewFile.value = detail;
      showPreview.value = true;
    } catch (err) {
      log.error("获取文件详情失败:", err);
      base.showError(err.message || "获取文件详情失败，请稍后重试");
    }
  };

  /**
   * 生成QR码
   */
  const generateQRCode = async (file, darkMode = false) => {
    try {
      const fileUrl = fileshareService.buildShareUrl(file, window.location.origin);

      qrCodeDataURL.value = await createQRCodeImage(fileUrl, { darkMode });

      qrCodeSlug.value = file.slug;
      showQRCodeModal.value = true;
    } catch (err) {
      log.error("生成二维码失败:", err);
      base.showError("生成二维码失败");
    }
  };

  /**
   * 切换全选状态（文件管理专用）
   */
  const toggleSelectAll = () => {
    base.toggleSelectAll(files.value, "id");
  };

  /**
   * 复制文件分享链接
   */
  const copyFileLink = async (file) => {
    if (!file || !file.slug) {
      base.showError("该文件没有有效的分享链接");
      return;
    }

    try {
      const fileUrl = fileshareService.buildShareUrl(file, window.location.origin);

      const ok = await copyToClipboard(fileUrl);
      if (ok) {
        base.showSuccess("分享链接已复制");
      }
    } catch (err) {
      log.error("复制链接失败:", err);
      // 只在失败时显示错误提示，成功时不显示顶部提示
      base.showError("复制链接失败，请手动复制");
    }
  };

  /**
   * 确保文件对象包含 previewUrl/downloadUrl（必要时按需拉取 include=links）
   * @param {any} file
   * @returns {Promise<any>}
   */
  const ensureLinks = async (file) => {
    if (!file || !file.id) return file;
    if (file.previewUrl || file.downloadUrl) return file;
    const detail = await fileShareStore.fetchById(file.id, { useCache: true, includeLinks: true });
    return detail || file;
  };

  /**
   * 复制文件永久下载链接
   */
  const copyPermanentLink = async (file) => {
    if (!file || !file.slug) {
      base.showError("该文件没有有效的分享链接");
      return;
    }

    try {
      const detail = await ensureLinks(file);
      // 使用统一的 Down 路由构造永久下载链接
      const permanentDownloadUrl = fileshareService.getPermanentDownloadUrl(detail);
      if (!permanentDownloadUrl) {
        throw new Error("无法获取文件的下载链接");
      }

      await copyToClipboard(permanentDownloadUrl);
      base.showSuccess("下载直链已复制");
    } catch (err) {
      log.error("复制永久链接失败:", err);
      base.showError(err.message || "复制永久链接失败，请稍后重试");
    }
  };

/**
   * 获取Office文件预览URL
   */
  const getOfficePreviewUrl = async (file) => {
    if (!file?.slug) return null;

    try {
      return await fileshareService.getOfficePreviewUrl(file);
    } catch (error) {
      log.error("获取Office预览URL失败:", error);
      base.showError(`预览失败: ${error.message}`);
      return null;
    }
  };

/**
   * 预览文件
   */
  const previewFileInNewWindow = async (file) => {
    if (!file.slug) {
      base.showError("无法预览：文件没有设置短链接");
      return;
    }

    try {
      const detail = await ensureLinks(file);
      // 检查是否为Office文件
      const { FileType } = await import("@/utils/fileTypes.js");
      if (detail.type === FileType.OFFICE) {
        // 获取Office预览URL
        const officePreviewUrl = await getOfficePreviewUrl(detail);
        if (officePreviewUrl) {
          window.open(officePreviewUrl, "_blank");
        }
        return;
      }

      // 非Office文件使用普通预览方式
      const previewUrl = getPermanentViewUrl(detail);
      if (!previewUrl) {
        throw new Error("无法获取文件的预览链接");
      }
      window.open(previewUrl, "_blank");
    } catch (err) {
      log.error("预览文件失败:", err);
      base.showError("预览文件失败，请稍后重试");
    }
  };

  /**
   * 下载文件
   */
  const downloadFileDirectly = async (file) => {
    try {
      // 检查是否有永久下载链接
      if (!file.slug) {
        base.showError("无法下载：文件没有设置短链接");
        return;
      }

      const detail = await ensureLinks(file);

      // 提取文件名，用于下载时的文件命名
      const fileName = detail.filename || "下载文件";

      // 创建一个隐藏的a标签
      const link = document.createElement("a");
      const downloadUrl = getPermanentDownloadUrl(detail);
      if (!downloadUrl) {
        throw new Error("无法获取文件的下载链接");
      }
      link.href = downloadUrl;
      link.download = fileName; // 设置下载文件名
      link.setAttribute("target", "_blank"); // 在新窗口打开
      document.body.appendChild(link);

      // 模拟点击下载
      link.click();

      // 移除临时创建的元素
      setTimeout(() => {
        document.body.removeChild(link);
      }, 100);
    } catch (err) {
      log.error("下载文件失败:", err);
      // 如果直接下载失败，尝试在新窗口打开下载链接
      if (file.slug) {
        try {
          const detail = await ensureLinks(file);
          window.open(getPermanentDownloadUrl(detail), "_blank");
        } catch {
          window.open(getPermanentDownloadUrl(file), "_blank");
        }
      } else {
        window.open(file.publicUrl || "", "_blank");
      }
    }
  };

  /**
   * 获取文件的永久下载链接
   */
  const getPermanentDownloadUrl = (file) => {
    return fileshareService.getPermanentDownloadUrl(file);
  };

/**
   * 获取文件的永久预览链接
   */
  const getPermanentViewUrl = (file) => {
    return fileshareService.getPermanentPreviewUrl(file);
  };

/**
   * 搜索文件
   * @param {string} searchTerm - 搜索关键词
   * @param {number} offset - 偏移量，默认为当前分页的offset
   * @returns {Promise<Object>} 搜索结果
   */
  const searchFiles = async (searchTerm, offset = null) => {
    if (!searchTerm || searchTerm.trim().length < 2) {
      return { files: [], pagination: { total: 0, limit: base.pagination.limit, offset: 0 } };
    }

    const searchOffset = offset !== null ? offset : base.pagination.offset;

    return await base.withLoading(async () => {
      try {
        const { files: results, pagination } = await fileShareStore.loadList({
          limit: base.pagination.limit,
          offset: searchOffset,
          search: searchTerm.trim(),
        });
        // 搜索换了一批文件，旧的检测结果不再对应
        clearValidity();
        return { files: results, pagination };
      } catch (error) {
        log.error("搜索文件失败:", error);
        base.showError(error.message || "搜索失败");
        return { files: [], pagination: { total: 0, limit: base.pagination.limit, offset: searchOffset } };
      }
    });
  };

  /**
   * 处理全局搜索（服务端）
   * - 规则：少于 2 个字视为“未搜索”
   */
  const handleGlobalSearch = async (value) => {
    searchQuery.value = value;

    if (!value || value.trim().length < 2) {
      await clearSearch();
      return;
    }

    try {
      searchLoading.value = true;
      isSearchMode.value = true;

      base.resetPagination();
      const result = await searchFiles(value.trim(), 0);
      base.updatePagination(result.pagination || { total: files.value.length, limit: base.pagination.limit, offset: 0 }, "offset");
      base.updateLastRefreshTime();
    } finally {
      searchLoading.value = false;
    }
  };

  /**
   * 清除搜索，回到正常分页列表
   */
  const clearSearch = async () => {
    searchQuery.value = "";
    isSearchMode.value = false;
    base.resetPagination();
    await loadFiles();
  };

  /**
   * 分页变化（支持搜索模式）
   */
  const handleOffsetChangeWithSearch = async (newOffset) => {
    if (isSearchMode.value && searchQuery.value) {
      try {
        searchLoading.value = true;
        const result = await searchFiles(searchQuery.value, newOffset);
        base.updatePagination(result.pagination || { total: files.value.length, limit: base.pagination.limit, offset: newOffset }, "offset");
      } finally {
        searchLoading.value = false;
      }
      return;
    }

    handleOffsetChange(newOffset);
  };

  /**
   * 每页数量变化（支持搜索模式）
   */
  const handlePageSizeChange = async (newPageSize) => {
    base.changePageSize(newPageSize);
    if (isSearchMode.value && searchQuery.value) {
      await handleGlobalSearch(searchQuery.value);
      return;
    }
    await loadFiles();
  };

  /**
   * 刷新当前列表（保持搜索/分页状态）
   */
  const refreshFiles = async () => {
    if (isSearchMode.value && searchQuery.value) {
      try {
        searchLoading.value = true;
        const result = await searchFiles(searchQuery.value, base.pagination.offset);
        base.updatePagination(result.pagination || { total: files.value.length, limit: base.pagination.limit, offset: base.pagination.offset }, "offset");
        base.updateLastRefreshTime();
      } finally {
        searchLoading.value = false;
      }
      return;
    }
    await loadFiles();
  };

/**
   * 关闭所有弹窗
   */
  const closeAllModals = () => {
    showEdit.value = false;
    showPreview.value = false;
    showQRCodeModal.value = false;
    editingFile.value = null;
    previewFile.value = null;
    qrCodeDataURL.value = "";
    qrCodeSlug.value = "";
  };

  return {
    // 继承基础功能
    ...base,

    // 搜索状态
    searchQuery,
    isSearchMode,
    searchLoading,

    // 文件管理特有状态
    files,
    editingFile,
    previewFile,
    showEdit,
    showPreview,
    showQRCodeModal,
    qrCodeDataURL,
    qrCodeSlug,

    // 文件有效性检测
    validityMap,
    verifying,
    verifyProgress,
    lastVerifySummary,
    invalidFileCount,
    invalidTotalCount,
    getValidityState,
    clearValidity,
    selectInvalidFiles,

    // 文件管理方法
    loadFiles,
    refreshFiles,
    searchFiles,
    handleOffsetChange,
    handleGlobalSearch,
    clearSearch,
    handleOffsetChangeWithSearch,
    handlePageSizeChange,
    handleFileDelete,
    handleBatchDelete,
    handleVerifyFiles,
    openEditModal,
    updateFileMetadata,
    openPreviewModal,
    generateQRCode,
    copyFileLink,
    copyPermanentLink,
    getOfficePreviewUrl,
    previewFileInNewWindow,
    downloadFileDirectly,
    getPermanentDownloadUrl,
    getPermanentViewUrl,
    toggleSelectAll,
    closeAllModals,
  };
}
