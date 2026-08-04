import { useState, useEffect, useCallback } from 'react';
import { open as openDialog, message } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { Lightbulb, X, FilePlus, FolderPlus, Search, Inbox } from 'lucide-react';
import { RecordCard } from './components/RecordCard';
import { CategorySidebar } from './components/CategorySidebar';
import type { RecordItem, CategoryFilter } from './types';

export const getCategory = (filename: string, is_dir?: boolean) => {
  const ext = filename.split('.').pop()?.toLowerCase();

  // 处理 Mac 上的 Bundle 文件夹（这些后缀即便被识别为文件夹，也应按具体类型分类）
  const bundleExts = ['app', 'key', 'scpt'];
  if (is_dir && (!ext || !bundleExts.includes(ext))) {
    return '文件夹';
  }

  if (!ext || ext === filename.toLowerCase()) return '其他文件';

  switch (ext) {
    case 'jpg': case 'jpeg': case 'png': case 'gif': case 'webp': case 'svg': case 'bmp': case 'ico': case 'tiff': case 'heic':
      return '图片';
    case 'mp4': case 'mkv': case 'avi': case 'mov': case 'wmv': case 'flv': case 'webm': case 'm4v':
      return '视频';
    case 'mp3': case 'wav': case 'ogg': case 'flac': case 'aac': case 'm4a': case 'wma':
      return '音频';
    case 'zip': case 'rar': case '7z': case 'tar': case 'gz': case 'bz2': case 'xz':
      return '压缩包';
    case 'dmg': case 'iso': case 'img': case 'vdi':
      return '磁盘镜像';
    case 'exe': case 'app': case 'msi': case 'apk': case 'pkg': case 'deb': case 'rpm': case 'ipa':
      return '应用程序';
    case 'sh': case 'bat': case 'cmd': case 'ps1': case 'scpt':
      return '脚本';
    case 'xls': case 'xlsx': case 'csv': case 'numbers': case 'ods':
      return '电子表格';
    case 'ppt': case 'pptx': case 'key': case 'odp':
      return '幻灯片';
    case 'pdf': case 'doc': case 'docx': case 'txt': case 'md': case 'rtf': case 'pages': case 'odt':
      return '文档';
    case 'psd': case 'ai': case 'xd': case 'sketch': case 'fig': case 'rp': case 'mockup': case 'figma':
      return '产品与设计';
    case 'sql': case 'db': case 'sqlite': case 'rdb': case 'mdb': case 'accdb':
      return '数据库';
    case 'json': case 'yaml': case 'yml': case 'toml': case 'xml': case 'ini': case 'env': case 'plist': case 'conf': case 'code-profile':
      return '配置文件';
    case 'js': case 'ts': case 'jsx': case 'tsx': case 'html': case 'css': case 'scss': case 'less':
    case 'py': case 'rs': case 'go': case 'java': case 'c': case 'cpp': case 'cs': case 'php':
    case 'rb': case 'swift': case 'kt': case 'dart': case 'vue': case 'svelte':
      return '代码文件';
    case 'ttf': case 'otf': case 'woff': case 'woff2':
      return '字体';
    default:
      return '其他文件';
  }
};

export default function QuickOpenApp() {
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [selectedFilter, setSelectedFilter] = useState<CategoryFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOption, setSortOption] = useState<'time-desc' | 'time-asc' | 'name-asc' | 'name-desc'>('time-desc');
  const [isDragging, setIsDragging] = useState(false);
  const [showTips, setShowTips] = useState(false);

  const fetchRecords = useCallback(async () => {
    try {
      const data = await invoke<RecordItem[]>('get_records_cmd');
      setRecords(data);
    } catch (err) {
      console.error('Failed to fetch records:', err);
    }
  }, []);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let isMounted = true;

    const setupDragDrop = async () => {
      const unlistenFn = await getCurrentWindow().onDragDropEvent(async (event) => {
        if (event.payload.type === 'enter' || event.payload.type === 'over') {
          setIsDragging(true);
        } else if (event.payload.type === 'leave') {
          setIsDragging(false);
        } else if (event.payload.type === 'drop') {
          setIsDragging(false);
          const paths = event.payload.paths;
          let added = false;
          let skippedCount = 0;

          for (const path of paths) {
            try {
              const is_dir = await invoke<boolean>('check_path_is_dir', { path });
              const name = path.split('/').pop() || path.split('\\').pop() || 'Untitled';

              const newRecord: RecordItem = {
                id: crypto.randomUUID(),
                name: name,
                path: path,
                is_dir: is_dir,
                category_id: undefined,
              };

              await invoke('add_record_cmd', { record: newRecord });
              added = true;
            } catch (err) {
              console.warn('Failed to add dropped path:', path, err);
              if (typeof err === 'string' && err.includes('已存在')) {
                skippedCount++;
              }
            }
          }

          if (skippedCount > 0) {
            setTimeout(() => {
              message(`${skippedCount} 个文件/文件夹已存在，已跳过`, { title: '提示', kind: 'warning' }).catch(console.error);
            }, 100);
          }

          if (added) {
            await fetchRecords();
          }
        }
      });

      if (isMounted) {
        unlisten = unlistenFn;
      } else {
        unlistenFn();
      }
    };

    setupDragDrop();

    return () => {
      isMounted = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, [fetchRecords]);

  const addRecordFromDialog = async (directory: boolean) => {
    try {
      const selected = await openDialog(
        directory
          ? { directory: true, title: '选择文件夹' }
          : { title: '选择文件' }
      );
      if (selected && typeof selected === 'string') {
        const name = selected.split('/').pop() || selected.split('\\').pop() || 'Untitled';
        const newRecord: RecordItem = {
          id: crypto.randomUUID(),
          name: name,
          path: selected,
          is_dir: directory,
          category_id: undefined,
        };

        try {
          await invoke('add_record_cmd', { record: newRecord });
          await fetchRecords();
        } catch (err) {
          if (typeof err === 'string') {
            await message(err, { title: '提示', kind: 'warning' });
          } else {
            console.error(err);
          }
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleOpenPath = async (path: string) => {
    try {
      await openPath(path);
    } catch (err) {
      console.error('Failed to open path:', err);
    }
  };

  const handleRevealPath = async (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    try {
      await revealItemInDir(path);
    } catch (err) {
      console.error('Failed to reveal path:', err);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (window.confirm('确定要从库中移除该条记录吗？（不会删除您电脑上的源文件或文件夹）')) {
      try {
        await invoke('delete_record_cmd', { id });
        await fetchRecords();
      } catch (err) {
        console.error('Failed to delete record:', err);
      }
    }
  };

  const categoryFilteredRecords = records.filter((r) => {
    if (selectedFilter === 'all') return true;
    return getCategory(r.name, r.is_dir) === selectedFilter;
  });

  const sortedAndFilteredRecords = categoryFilteredRecords
    .filter(r =>
      r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.path.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .sort((a, b) => {
      if (sortOption === 'name-asc') return a.name.localeCompare(b.name);
      if (sortOption === 'name-desc') return b.name.localeCompare(a.name);

      const timeA = a.created_at ? new Date(a.created_at.replace(' ', 'T') + 'Z').getTime() : 0;
      const timeB = b.created_at ? new Date(b.created_at.replace(' ', 'T') + 'Z').getTime() : 0;

      if (sortOption === 'time-asc') return timeA - timeB;
      return timeB - timeA;
    });

  const groupedRecords = sortedAndFilteredRecords.reduce((acc, record) => {
    const category = getCategory(record.name, record.is_dir);
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(record);
    return acc;
  }, {} as Record<string, RecordItem[]>);

  const selectedCategoryName = selectedFilter !== 'all' ? selectedFilter : null;
  const totalCount = records.length;
  const categoryCount = new Set(records.map(r => getCategory(r.name, r.is_dir))).size;

  const renderRecordGrid = (items: RecordItem[]) => (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5">
      {items.map(r => (
        <RecordCard
          key={r.id}
          name={r.name}
          path={r.path}
          is_dir={r.is_dir}
          screenshot_path={r.screenshot_path}
          onClick={() => handleOpenPath(r.path)}
          onContextMenu={(e) => handleRevealPath(e, r.path)}
          onDelete={(e) => handleDelete(e, r.id)}
        />
      ))}
    </div>
  );

  return (
    <div
      className="flex h-screen overflow-hidden bg-gray-50 relative"
      onContextMenu={(e) => e.preventDefault()}
    >
      <CategorySidebar
        records={records}
        selectedFilter={selectedFilter}
        onSelectFilter={setSelectedFilter}
        getCategory={getCategory}
      />

      <div className="flex flex-col flex-1 min-w-0 relative">
        {isDragging && (
          <div className="absolute inset-0 z-50 bg-blue-500/10 backdrop-blur-[2px] border-4 border-blue-500 border-dashed m-4 rounded-2xl flex items-center justify-center pointer-events-none transition-all duration-200">
            <div className="bg-white/90 px-8 py-6 rounded-xl shadow-lg flex flex-col items-center gap-3 transform scale-105">
              <div className="p-4 bg-blue-100 rounded-full">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <p className="text-xl font-bold text-gray-800">松开鼠标以添加到库</p>
              <p className="text-sm text-gray-500">
                支持拖拽多个文件或文件夹
                {selectedCategoryName && (
                  <span className="block mt-1 text-blue-600">将添加到「{selectedCategoryName}」分类</span>
                )}
              </p>
            </div>
          </div>
        )}

        <div className="flex-shrink-0 px-8 pt-7 pb-3">
          <div className="flex justify-between items-end mb-5">
            <div>
              <h1 className="text-2xl font-bold text-gray-800 whitespace-nowrap">我的快开库</h1>
              <p className="text-xs text-gray-500 mt-1">
                共 <span className="font-semibold text-gray-700">{totalCount}</span> 个项目 ·
                <span className="font-semibold text-gray-700"> {categoryCount}</span> 个分类
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                title="使用提示"
                onClick={() => setShowTips(v => !v)}
                className={`p-2 rounded-lg border transition-colors ${showTips
                    ? 'bg-amber-50 border-amber-200 text-amber-600'
                    : 'bg-white border-gray-200 text-gray-500 hover:text-amber-500 hover:border-amber-200'
                  }`}
              >
                <Lightbulb size={18} />
              </button>
              <button
                type="button"
                onClick={() => addRecordFromDialog(false)}
                className="inline-flex items-center gap-1.5 bg-blue-600 text-white px-4 py-2 rounded-lg shadow-sm hover:bg-blue-700 transition-colors whitespace-nowrap font-medium"
              >
                <FilePlus size={16} />
                添加文件
              </button>
              <button
                type="button"
                onClick={() => addRecordFromDialog(true)}
                className="inline-flex items-center gap-1.5 bg-white text-blue-700 border border-blue-200 px-4 py-2 rounded-lg shadow-sm hover:bg-blue-50 transition-colors whitespace-nowrap font-medium"
              >
                <FolderPlus size={16} />
                添加文件夹
              </button>
            </div>
          </div>

          <div className="flex gap-3 mb-4">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              <input
                type="text"
                placeholder="搜索名称或路径..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-10 py-2 rounded-lg border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent shadow-sm transition-shadow"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 focus:outline-none p-1 rounded-full hover:bg-gray-100 transition-colors"
                  title="清空"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <select
              value={sortOption}
              onChange={(e) => setSortOption(e.target.value as typeof sortOption)}
              className="px-3 py-2 rounded-lg border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm text-gray-700 cursor-pointer outline-none min-w-[150px] transition-shadow"
            >
              <option value="time-desc">添加时间（最新）</option>
              <option value="time-asc">添加时间（最早）</option>
              <option value="name-asc">文件名称 (A-Z)</option>
              <option value="name-desc">文件名称 (Z-A)</option>
            </select>
          </div>

          {showTips && (
            <div className="mb-2 text-sm text-gray-600 bg-amber-50/60 p-4 rounded-xl border border-amber-100 relative animate-fade-in-down">
              <button
                type="button"
                onClick={() => setShowTips(false)}
                className="absolute top-2.5 right-2.5 text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-white/60 transition-colors"
                title="收起"
              >
                <X size={14} />
              </button>
              <p className="font-semibold text-gray-800 mb-2 flex items-center gap-1.5">
                <Lightbulb size={14} className="text-amber-500" />
                使用提示
              </p>
              <ul className="list-disc list-inside space-y-1 leading-relaxed">
                <li>左侧 <span className="font-semibold text-blue-600">分类树</span> 可自定义层级，点击分类过滤右侧卡片。</li>
                <li><span className="font-semibold">支持拖拽</span>：将外部文件或文件夹拖到窗口中即可快速添加。</li>
                <li><span className="font-semibold">左键点击卡片</span>：按系统默认方式打开文件，或在访达/资源管理器中打开文件夹。</li>
                <li><span className="font-semibold">右键点击卡片</span>：在访达 (Mac) 或资源管理器 (Windows) 中定位位置。</li>
              </ul>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-4">
          {sortedAndFilteredRecords.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-400">
              <div className="w-20 h-20 rounded-full bg-gray-100 flex items-center justify-center mb-4">
                <Inbox size={36} className="text-gray-300" />
              </div>
              <p className="text-base font-medium text-gray-500">
                {searchQuery
                  ? '没有匹配的记录'
                  : selectedCategoryName
                    ? `「${selectedCategoryName}」分类下暂无记录`
                    : '库中还没有记录'}
              </p>
              {!searchQuery && !selectedCategoryName && (
                <div className="flex gap-2 mt-5">
                  <button
                    type="button"
                    onClick={() => addRecordFromDialog(false)}
                    className="inline-flex items-center gap-1.5 bg-blue-600 text-white px-4 py-2 rounded-lg shadow-sm hover:bg-blue-700 transition-colors text-sm font-medium"
                  >
                    <FilePlus size={15} />
                    添加文件
                  </button>
                  <button
                    type="button"
                    onClick={() => addRecordFromDialog(true)}
                    className="inline-flex items-center gap-1.5 bg-white text-blue-700 border border-blue-200 px-4 py-2 rounded-lg shadow-sm hover:bg-blue-50 transition-colors text-sm font-medium"
                  >
                    <FolderPlus size={15} />
                    添加文件夹
                  </button>
                </div>
              )}
              {!searchQuery && !selectedCategoryName && (
                <p className="text-xs text-gray-400 mt-3">或将文件直接拖入窗口</p>
              )}
            </div>
          ) : selectedFilter === 'all' ? (
            <div className="space-y-8">
              {Object.entries(groupedRecords).map(([category, items]) => (
                <div key={category}>
                  <div className="flex items-center gap-2 mb-4 border-b border-gray-200 pb-2">
                    <h2 className="text-lg font-bold text-gray-700">{category}</h2>
                    <span className="bg-blue-100 text-blue-700 text-xs font-semibold px-2.5 py-0.5 rounded-full">
                      {items.length}
                    </span>
                  </div>
                  {renderRecordGrid(items)}
                </div>
              ))}
            </div>
          ) : (
            <div>
              {selectedCategoryName && (
                <div className="flex items-center gap-2 mb-4 border-b border-gray-200 pb-2">
                  <h2 className="text-lg font-bold text-gray-700">{selectedCategoryName}</h2>
                  <span className="bg-blue-100 text-blue-700 text-xs font-semibold px-2.5 py-0.5 rounded-full">
                    {sortedAndFilteredRecords.length}
                  </span>
                </div>
              )}
              {renderRecordGrid(sortedAndFilteredRecords)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
