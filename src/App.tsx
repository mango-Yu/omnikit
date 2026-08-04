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
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <nav className="w-[72px] flex-shrink-0 bg-slate-900 flex flex-col items-center py-4 gap-1.5 border-r border-slate-800">
        <div className="mb-3 flex flex-col items-center text-white text-[10px] font-bold tracking-wider opacity-70 leading-tight">
          <span>Omni</span>
          <span>Kit</span>
        </div>
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
          const active = activeView === id;
          return (
            <button
              key={id}
              type="button"
              title={label}
              onClick={() => setActiveView(id)}
              className={`flex flex-col items-center gap-1 w-[60px] py-2.5 rounded-xl transition-all duration-150 ${
                active
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/40'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              <Icon size={20} />
              <span className="text-[11px] leading-tight text-center px-0.5 break-keep">
                {label}
              </span>
            </button>
          );
        })}
      </nav>

      <main className="flex-1 min-w-0 h-full overflow-hidden">
        <div className={activeView === 'quickopen' ? 'h-full animate-fade-in' : 'hidden'}>
          <QuickOpenApp />
        </div>
        <div className={activeView === 'gif-composer' ? 'h-full animate-fade-in' : 'hidden'}>
          <GifComposer />
        </div>
      </main>
    </div>
  );
}
