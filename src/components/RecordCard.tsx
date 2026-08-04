import React from 'react';
import { 
  FileText, Image as ImageIcon, FileArchive, 
  File, HardDrive, Package,
  Video, Music, FileCode, Database, 
  FileSpreadsheet, FileJson, Terminal, Type, Presentation, Trash2, Folder, Palette
} from 'lucide-react';

interface RecordCardProps {
  name: string;
  path: string;
  is_dir?: boolean;
  screenshot_path?: string;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDelete?: (e: React.MouseEvent) => void;
}

const getFileIcon = (filename: string) => {
  const ext = filename.split('.').pop()?.toLowerCase();
  
  // 没有扩展名或者是点开头的文件
  if (!ext || ext === filename.toLowerCase()) {
    return <File size={48} className="text-gray-400" />;
  }

  switch (ext) {
    // 图片
    case 'jpg': case 'jpeg': case 'png': case 'gif': case 'webp': case 'svg': case 'bmp': case 'ico': case 'tiff': case 'heic':
      return <ImageIcon size={48} className="text-blue-400" />;
    
    // 视频
    case 'mp4': case 'mkv': case 'avi': case 'mov': case 'wmv': case 'flv': case 'webm': case 'm4v':
      return <Video size={48} className="text-purple-400" />;
      
    // 音频
    case 'mp3': case 'wav': case 'ogg': case 'flac': case 'aac': case 'm4a': case 'wma':
      return <Music size={48} className="text-pink-400" />;
      
    // 压缩包
    case 'zip': case 'rar': case '7z': case 'tar': case 'gz': case 'bz2': case 'xz':
      return <FileArchive size={48} className="text-orange-400" />;
      
    // 磁盘镜像
    case 'dmg': case 'iso': case 'img': case 'vdi':
      return <HardDrive size={48} className="text-gray-500" />;
      
    // 可执行/脚本/安装包
    case 'exe': case 'app': case 'msi': case 'apk': case 'pkg': case 'deb': case 'rpm': case 'ipa':
      return <Package size={48} className="text-emerald-500" />;
    case 'sh': case 'bat': case 'cmd': case 'ps1': case 'scpt':
      return <Terminal size={48} className="text-slate-600" />;
      
    // 电子表格
    case 'xls': case 'xlsx': case 'csv': case 'numbers': case 'ods':
      return <FileSpreadsheet size={48} className="text-emerald-400" />;
      
    // 幻灯片
    case 'ppt': case 'pptx': case 'key': case 'odp':
      return <Presentation size={48} className="text-orange-500" />;
      
    // 文档/文本
    case 'pdf': case 'doc': case 'docx': case 'txt': case 'md': case 'rtf': case 'pages': case 'odt':
      return <FileText size={48} className="text-indigo-400" />;
      
    // 产品与设计
    case 'psd': case 'ai': case 'xd': case 'sketch': case 'fig': case 'rp': case 'mockup': case 'figma':
      return <Palette size={48} className="text-fuchsia-500" />;
      
    // 数据库
    case 'sql': case 'db': case 'sqlite': case 'rdb': case 'mdb': case 'accdb':
      return <Database size={48} className="text-cyan-600" />;
      
    // 配置文件/数据结构
    case 'json': case 'yaml': case 'yml': case 'toml': case 'xml': case 'ini': case 'env': case 'plist': case 'conf': case 'code-profile':
      return <FileJson size={48} className="text-yellow-500" />;
      
    // 代码文件
    case 'js': case 'ts': case 'jsx': case 'tsx': case 'html': case 'css': case 'scss': case 'less': 
    case 'py': case 'rs': case 'go': case 'java': case 'c': case 'cpp': case 'cs': case 'php': 
    case 'rb': case 'swift': case 'kt': case 'dart': case 'vue': case 'svelte':
      return <FileCode size={48} className="text-sky-500" />;
      
    // 字体
    case 'ttf': case 'otf': case 'woff': case 'woff2':
      return <Type size={48} className="text-stone-500" />;
      
    default:
      return <File size={48} className="text-gray-400" />;
  }
};

export const RecordCard: React.FC<RecordCardProps> = ({ name, path, is_dir, screenshot_path, onClick, onContextMenu, onDelete }) => {
  return (
    <div
      className="group relative border rounded-xl shadow-sm p-4 flex flex-col items-center hover:shadow-lg hover:-translate-y-0.5 hover:border-blue-200 transition-all duration-200 cursor-pointer bg-white"
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {onDelete && (
        <button
          onClick={onDelete}
          className="absolute top-2 right-2 p-1.5 bg-white/90 hover:bg-red-50 text-gray-400 hover:text-red-500 rounded-lg opacity-0 group-hover:opacity-100 transition-all duration-150 backdrop-blur-sm shadow-sm hover:scale-110"
          title="删除此记录"
        >
          <Trash2 size={16} />
        </button>
      )}
      {screenshot_path ? (
        <img src={screenshot_path} alt={name} className="w-full h-32 object-cover mb-3 rounded-lg border border-gray-100" loading="lazy" />
      ) : (
        <div className="w-full h-32 bg-gradient-to-br from-slate-50 to-slate-100 group-hover:from-blue-50/50 group-hover:to-blue-50 transition-colors mb-3 flex flex-col items-center justify-center rounded-lg border border-slate-100 group-hover:border-blue-100">
          {is_dir && !['app', 'key', 'scpt'].includes(name.split('.').pop()?.toLowerCase() || '') ? (
            <Folder size={48} className="text-amber-500 transition-transform duration-200 group-hover:scale-110" />
          ) : (
            <div className="transition-transform duration-200 group-hover:scale-110">
              {getFileIcon(name)}
            </div>
          )}
        </div>
      )}
      <h3
        className="font-semibold text-sm w-full text-gray-800 break-all leading-snug line-clamp-2 group-hover:text-blue-700 transition-colors"
        title={name}
      >
        {name}
      </h3>
      <p className="text-xs text-gray-400 truncate w-full mt-1" title={path}>{path}</p>
    </div>
  );
};
