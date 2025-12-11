import { useState } from 'react';

interface SettingsPanelProps {
  onSave: () => void;
  onReset: () => void;
}

export function SettingsPanel({ onSave, onReset }: SettingsPanelProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [exportData, setExportData] = useState('');

  const handleExport = () => {
    // TODO: Get actual serializable state from engine
    const data = { message: 'Export not yet implemented - requires persistence API' };
    setExportData(JSON.stringify(data, null, 2));
  };

  const handleImport = () => {
    // TODO: Import state into engine
    alert('Import not yet implemented - requires persistence API');
  };

  const handleReset = () => {
    if (showConfirm) {
      onReset();
    } else {
      setShowConfirm(true);
      setTimeout(() => setShowConfirm(false), 3000);
    }
  };

  return (
    <div className="bg-cosmic-900/50 rounded-lg p-4 backdrop-blur-sm border border-cosmic-700">
      <h2 className="text-gold-400 font-display text-xl mb-4">Settings</h2>

      <div className="space-y-4">
        <div className="flex gap-2">
          <button
            onClick={onSave}
            className="px-4 py-2 bg-green-700 text-white rounded hover:bg-green-600 transition-colors"
          >
            Save Game
          </button>
          <button
            onClick={handleExport}
            className="px-4 py-2 bg-cosmic-700 text-cosmic-200 rounded hover:bg-cosmic-600 transition-colors"
          >
            Export
          </button>
          <button
            onClick={handleImport}
            className="px-4 py-2 bg-cosmic-700 text-cosmic-200 rounded hover:bg-cosmic-600 transition-colors"
          >
            Import
          </button>
        </div>

        {exportData && (
          <div className="mt-4">
            <label className="text-cosmic-300 text-sm block mb-1">Export Data:</label>
            <textarea
              readOnly
              value={exportData}
              className="w-full h-24 bg-cosmic-800 text-cosmic-200 rounded p-2 font-mono text-xs"
            />
          </div>
        )}

        <div className="border-t border-cosmic-700 pt-4 mt-4">
          <button
            onClick={handleReset}
            className={`px-4 py-2 rounded transition-colors ${
              showConfirm
                ? 'bg-red-600 text-white'
                : 'bg-red-900/50 text-red-300 hover:bg-red-800/50'
            }`}
          >
            {showConfirm ? 'Click Again to Confirm Reset' : 'Reset Game'}
          </button>
          {showConfirm && (
            <p className="text-red-400 text-sm mt-1">
              Warning: This will delete all progress!
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
