import { useState } from 'react';
import { Zap, Film } from 'lucide-react';
import QuickOpenApp from './QuickOpenApp';
import GifComposer from './features/gif-composer/GifComposer';

type AppView = 'quickopen' | 'gif-composer';

const NAV_ITEMS: { id: AppView; label: string; icon: typeof Zap }[] = [
  { id: 'quickopen', label: '快开', icon: Zap },
  { id: 'gif-composer', label: 'GIF 合成器', icon: Film },
];

export default function App() {
  const [activeView, setActiveView] = useState<AppView>('quickopen');

  return (
    <div className="flex h-screen overflow-hidden bg-gray-100">
      <nav className="w-16 flex-shrink-0 bg-slate-900 flex flex-col items-center py-4 gap-2 border-r border-slate-800">
        <div className="mb-4 flex flex-col items-center text-white text-[10px] font-bold tracking-wider opacity-60 leading-tight">
          <span>OmniKit</span>
          <span className="text-[8px] font-normal opacity-80 mt-0.5">All your tools, one place</span>
        </div>
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
          const active = activeView === id;
          return (
            <button
              key={id}
              type="button"
              title={label}
              onClick={() => setActiveView(id)}
              className={`flex flex-col items-center gap-1 w-12 py-2.5 rounded-xl transition-colors ${
                active
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/40'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              <Icon size={22} />
              <span className="text-[10px] leading-tight text-center">{label}</span>
            </button>
          );
        })}
      </nav>

      <div className="flex-1 min-w-0 h-full overflow-hidden">
        <div className={activeView === 'quickopen' ? 'h-full' : 'hidden'}>
          <QuickOpenApp />
        </div>
        <div className={activeView === 'gif-composer' ? 'h-full' : 'hidden'}>
          <GifComposer />
        </div>
      </div>
    </div>
  );
}
