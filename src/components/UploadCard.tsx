import { Upload, FileText, X, FileSpreadsheet } from 'lucide-react';
import { isSupportedFile } from '../utils/fileToCsvText';

interface UploadedFile {
  name: string;
  size: number;
  lines: number;
}

interface UploadCardProps {
  file: UploadedFile | null;
  onFileSelect: (file: File) => void;
  onRemoveFile: () => void;
}

const ACCEPT = '.csv,.xlsx,.xls,.xlsm,.xlsb,.tsv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel';

export function UploadCard({ file, onFileSelect, onRemoveFile }: UploadCardProps) {
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile && isSupportedFile(droppedFile)) {
      onFileSelect(droppedFile);
    }
  };

  const handleClick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT;
    input.onchange = (e) => {
      const selectedFile = (e.target as HTMLInputElement).files?.[0];
      if (selectedFile) onFileSelect(selectedFile);
    };
    input.click();
  };

  if (file) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Arquivo carregado</h2>
        <div className="flex items-center gap-4 p-4 bg-emerald-50 border border-emerald-100 rounded-xl">
          <div className="w-12 h-12 bg-emerald-100 rounded-lg flex items-center justify-center flex-shrink-0">
            <FileSpreadsheet className="w-6 h-6 text-emerald-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate">{file.name}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {(file.size / 1024).toFixed(1)} KB &middot; {file.lines} linhas detectadas
            </p>
          </div>
          <button
            onClick={onRemoveFile}
            className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
            aria-label="Remover arquivo"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Upload do arquivo</h2>
      <div
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onClick={handleClick}
        className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center cursor-pointer hover:border-whatsapp-400 hover:bg-emerald-50/30 transition-all group"
      >
        <div className="w-14 h-14 bg-gray-100 group-hover:bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4 transition-colors">
          <Upload className="w-6 h-6 text-gray-400 group-hover:text-emerald-600 transition-colors" />
        </div>
        <p className="text-sm font-medium text-gray-700">Arraste seu CSV ou XLSX aqui</p>
        <p className="text-xs text-gray-400 mt-1">Ou clique para selecionar um arquivo</p>
        <p className="text-xs text-gray-400 mt-1">
          Aceita .csv, .xlsx, .xls, .tsv ou .txt
        </p>
      </div>
      <div className="mt-4 p-3 bg-gray-50 rounded-lg">
        <p className="text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1.5">
          <FileText className="w-3.5 h-3.5" />
          Formato esperado:
        </p>
        <code className="text-xs text-gray-600 block font-mono leading-relaxed">
          telefone,nome<br />
          11999999999,João Silva
        </code>
        <p className="text-xs text-gray-400 mt-2">
          Em XLSX usamos a primeira aba; cabeçalhos são detectados automaticamente.
        </p>
      </div>
    </div>
  );
}
