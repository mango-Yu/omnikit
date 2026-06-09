import { Layers, Folder } from 'lucide-react';
import type { CategoryFilter, RecordItem } from '../types';

interface CategorySidebarProps {
  records: RecordItem[];
  selectedFilter: CategoryFilter;
  onSelectFilter: (filter: CategoryFilter) => void;
  getCategory: (filename: string, is_dir?: boolean) => string;
}

export function CategorySidebar({
  records,
  selectedFilter,
  onSelectFilter,
  getCategory,
}: CategorySidebarProps) {
  const allCount = records.length;
  
  const grouped = records.reduce((acc, record) => {
    const cat = getCategory(record.name, record.is_dir);
    acc[cat] = (acc[cat] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // 按记录数量从多到少排序，或按名称字母排序
  const sortedCategories = Object.entries(grouped).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  return (
    <aside className="w-60 flex-shrink-0 border-r border-gray-200 bg-white flex flex-col h-full">
      <div className="px-4 py-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">文件分类</h2>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3 space-y-0.5">
        <div
          className={`flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors ${
            selectedFilter === 'all' ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-100 text-gray-700'
          }`}
          onClick={() => onSelectFilter('all')}
        >
          <Layers size={16} className={selectedFilter === 'all' ? 'text-blue-500' : 'text-gray-400'} />
          <span className="flex-1 text-sm font-medium">全部</span>
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${
            selectedFilter === 'all' ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-500'
          }`}>
            {allCount}
          </span>
        </div>

        {sortedCategories.length > 0 && (
          <div className="pt-2 mt-2 border-t border-gray-100 space-y-0.5">
            {sortedCategories.map(([cat, count]) => {
              const isSelected = selectedFilter === cat;
              return (
                <div
                  key={cat}
                  className={`group flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors ${
                    isSelected ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-100 text-gray-700'
                  }`}
                  onClick={() => onSelectFilter(cat)}
                >
                  <Folder size={16} className={isSelected ? 'text-blue-500' : 'text-amber-500'} />
                  <span className="flex-1 text-sm truncate">{cat}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                    isSelected ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
