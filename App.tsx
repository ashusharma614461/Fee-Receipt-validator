import React, { useState, useCallback, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { CsvRow, ProcessingResult, StudentData } from './types';
import { validateReceipt } from './services/geminiService';
import Header from './components/Header';
import Spinner from './components/Spinner';
import { FileIcon, DownloadIcon, RefreshIcon, ChevronDownIcon, ChevronUpIcon, ClipboardIcon } from './components/IconComponents';
import ResultsTable from './components/ResultsTable';
import PieChart from './components/PieChart';

const App: React.FC = () => {
  const [sheetUrl, setSheetUrl] = useState<string>('');
  const [processedData, setProcessedData] = useState<CsvRow[]>([]);
  const [results, setResults] = useState<ProcessingResult[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isFetchingSheet, setIsFetchingSheet] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [showInstructions, setShowInstructions] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const normalizeHeader = (header: string): string => {
    return header
      .trim()
      .toLowerCase()
      .replace(/[^a-zA-Z0-9]+(.)/g, (_, chr) => chr.toUpperCase());
  };

  const parseAndValidateCsv = (csvText: string) => {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) {
      setError('The fetched data is empty or invalid. Please check the Google Sheet.');
      setProcessedData([]);
      return;
    }

    const headers = lines[0].split(',').map(h => normalizeHeader(h.replace(/"/g, '')));
    const data = lines.slice(1).map(line => {
      // Basic CSV parsing to handle commas within quoted fields
      const values = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
      return headers.reduce((obj, header, index) => {
        obj[header] = values[index]?.trim().replace(/"/g, '') || '';
        return obj;
      }, {} as CsvRow);
    });
    
    if (data.length === 0) {
      setError('The file is empty or could not be parsed correctly.');
      setProcessedData([]);
      return;
    }
    
    const requiredColumns = ['name', 'amount', 'utr', 'paymentDate', 'campusName', 'paymentScreenshotUrl'];
    const firstRow = data[0];
    const missingColumns = requiredColumns.filter(col => !firstRow.hasOwnProperty(col));

    if (missingColumns.length > 0) {
      setError(`The sheet is missing required columns: ${missingColumns.join(', ')}. Please correct the sheet and re-fetch.`);
      setProcessedData([]);
      return;
    }
    setProcessedData(data);
  };

  const handleFetchData = useCallback(async () => {
    if (!sheetUrl) {
      setError('Please enter a Google Sheet URL.');
      return;
    }
    setIsFetchingSheet(true);
    setError(null);
    setProcessedData([]);
    setResults([]);

    try {
      // Use a proxy to bypass CORS issues if necessary, though public CSVs are usually fine.
      const response = await fetch(sheetUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch data (Status: ${response.status}). Ensure the URL is correct and the sheet is published to the web.`);
      }
      const text = await response.text();
      parseAndValidateCsv(text);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
      setError(`Failed to fetch from URL. ${errorMessage}`);
      setProcessedData([]);
    } finally {
      setIsFetchingSheet(false);
    }
  }, [sheetUrl]);

  const getBase64FromUrl = async (url: string): Promise<{ base64: string, mimeType: string }> => {
    // To prevent CORS issues with images, we can use a proxy. For this app, let's assume direct access is possible.
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch image from URL: ${response.statusText}`);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        resolve({ base64: result.split(',')[1], mimeType: blob.type });
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const handleProcessData = useCallback(async () => {
    if (processedData.length === 0) {
      setError('No data to process. Please fetch data from a Google Sheet first.');
      return;
    }
    
    setIsLoading(true);
    setError(null);
    setResults([]);
    setProgress({ current: 0, total: processedData.length });

    const newResults: ProcessingResult[] = [];

    for (const [index, row] of processedData.entries()) {
      setProgress({ current: index + 1, total: processedData.length });
      let result: ProcessingResult;
      try {
        if (!row.paymentScreenshotUrl || row.paymentScreenshotUrl.trim() === '') {
            throw new Error('"paymentScreenshotUrl" is missing or empty for this row.');
        }
        const { base64, mimeType } = await getBase64FromUrl(row.paymentScreenshotUrl);
        
        const studentDataForApi: StudentData = {
          userId: row.userId || '',
          name: row.name || '',
          amount: row.amount || '',
          campusName: row.campusName || '',
          paymentDate: row.paymentDate || '',
          utr: row.utr || '',
        };
        
        const validation = await validateReceipt(base64, mimeType, studentDataForApi);
        result = {
          originalData: row,
          validation,
          timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        
        if (index === 0 && errorMessage.includes('Invalid API Key')) {
            setError(`Critical Error: ${errorMessage} Processing has been stopped. Please check your application configuration.`);
            setIsLoading(false);
            setResults([{
                originalData: row,
                error: `Processing stopped due to critical error: ${errorMessage}`,
                timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
            }]);
            return;
        }

        result = {
          originalData: row,
          error: errorMessage,
          timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
        };
      }
      newResults.push(result);
      setResults([...newResults]);
    }

    setIsLoading(false);
  }, [processedData]);

  const copyResultsForSheet = () => {
      if (results.length === 0) return;

      const headers = ['Validation Status', 'Observations', 'Last Validated'];
      const rows = results.map(res => {
          const status = res.validation?.Validation_Status || 'Processing Error';
          const observations = (res.validation?.Observations || res.error || '').replace(/"/g, '""'); // Escape double quotes for CSV
          const timestamp = res.timestamp;
          return [status, `"${observations}"`, timestamp].join('\t'); // Use tabs to be safe for pasting
      });

      const tsvContent = [headers.join('\t'), ...rows].join('\n');
      navigator.clipboard.writeText(tsvContent).then(() => {
          setIsCopied(true);
          setTimeout(() => setIsCopied(false), 2000);
      });
  };

  const downloadResults = () => {
    if (results.length === 0) return;

    const dataForSheet = results.map(res => {
        const extractedInfo = res.validation?.Extracted_Information;
        const validationStatus = res.validation?.Validation_Status || (res.error ? 'Processing Error' : '');
        const observations = res.validation?.Observations || res.error || '';

        return {
            'User ID': res.originalData.userId,
            'Name': res.originalData.name,
            'Amount': res.originalData.amount,
            'Campus Name': res.originalData.campusName,
            'Payment Date': res.originalData.paymentDate,
            'UTR': res.originalData.utr,
            'Screenshot URL': res.originalData.paymentScreenshotUrl,
            'Extracted Student Name': extractedInfo?.Student_Name || '',
            'Extracted Amount': extractedInfo?.Amount || '',
            'Extracted Campus': extractedInfo?.Campus || '',
            'Extracted Payment Date': extractedInfo?.Payment_Date || '',
            'Extracted Transaction Details': extractedInfo?.Transaction_Details || '',
            'Extracted Reference Number': extractedInfo?.Reference_Number || '',
            'Extracted Proof Type': extractedInfo?.Proof_Type || '',
            'Extracted Logo Present': extractedInfo?.Logo_Present ?? '',
            'Extracted Stamp Present': extractedInfo?.Stamp_Present ?? '',
            'Validation Status': validationStatus,
            'Observations': observations,
            'Last Validated': res.timestamp
        };
    });

    const worksheet = XLSX.utils.json_to_sheet(dataForSheet);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Validation Results');
    XLSX.writeFile(workbook, 'validation_results.xlsx');
  };

  const chartData = useMemo(() => {
    if (results.length === 0) return [];
    const counts = results.reduce(
      (acc, res) => {
        if (res.error) acc.error++;
        else if (res.validation) {
          switch (res.validation.Validation_Status) {
            case 'Receipt Validated': acc.validated++; break;
            case 'Mismatch Found': acc.mismatch++; break;
            case 'Not Readable – Human Review Required': acc.review++; break;
          }
        }
        return acc;
      },
      { validated: 0, mismatch: 0, review: 0, error: 0 }
    );
    return [
      { name: 'Validated', value: counts.validated, color: '#22c55e' },
      { name: 'Mismatch', value: counts.mismatch, color: '#ef4444' },
      { name: 'Needs Review', value: counts.review, color: '#f59e0b' },
      { name: 'Error', value: counts.error, color: '#6b7280' },
    ].filter(item => item.value > 0);
  }, [results]);

  return (
    <div className="min-h-screen font-sans text-gray-900">
      <div className="container mx-auto p-4 md:p-8">
        <main className="bg-white shadow-xl rounded-xl">
          <Header />
          <div className="p-8 space-y-8">
            <div className="bg-gray-50 p-6 rounded-lg border border-gray-200">
                <h2 className="text-xl font-semibold text-gray-700 mb-3">1. Connect Google Sheet</h2>
                 <div className="text-sm text-gray-600 mb-4">
                    <button onClick={() => setShowInstructions(!showInstructions)} className="font-semibold text-indigo-600 hover:text-indigo-500 flex items-center gap-1">
                        How to get your Google Sheet URL
                        {showInstructions ? <ChevronUpIcon className="w-4 h-4" /> : <ChevronDownIcon className="w-4 h-4" />}
                    </button>
                    {showInstructions && (
                        <ol className="list-decimal list-inside mt-2 space-y-1 bg-indigo-50 p-3 rounded-md">
                            <li>Open your Google Sheet.</li>
                            <li>Go to <strong>File</strong> &gt; <strong>Share</strong> &gt; <strong>Publish to web</strong>.</li>
                            <li>In the `Link` tab, select the specific sheet, and choose <strong>Comma-separated values (.csv)</strong>.</li>
                            <li>Click <strong>Publish</strong>, confirm, and copy the generated URL.</li>
                        </ol>
                    )}
                </div>

                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
                     <input
                        type="url"
                        value={sheetUrl}
                        onChange={(e) => setSheetUrl(e.target.value)}
                        placeholder="Paste published Google Sheet CSV URL here"
                        className="flex-grow w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                        aria-label="Google Sheet URL"
                     />
                     <div className="flex items-center gap-2">
                        <button
                            onClick={handleFetchData}
                            disabled={isFetchingSheet || !sheetUrl}
                            className="inline-flex items-center justify-center gap-2 px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                        >
                            {isFetchingSheet ? (
                                <>
                                <svg className="animate-spin -ml-1 mr-2 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                Fetching...
                                </>
                            ) : 'Fetch Data'}
                        </button>
                        {processedData.length > 0 && !isFetchingSheet && (
                            <button onClick={handleFetchData} className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md" title="Refresh data from Google Sheet">
                                <RefreshIcon className="w-5 h-5"/>
                            </button>
                        )}
                    </div>
                </div>
                 {processedData.length > 0 && !isFetchingSheet && (
                    <div className="mt-3 flex items-center space-x-2 text-sm text-green-700 bg-green-50 p-2 rounded-md">
                        <FileIcon className="w-5 h-5 text-green-500"/>
                        <span>Successfully fetched {processedData.length} rows. Ready to process.</span>
                    </div>
                 )}
                 <p className="text-xs text-gray-500 mt-2">Required columns: name, amount, UTR, payment_date, campus_name, and payment_screenshot_url.</p>
            </div>
            
            <div className="text-center">
              <button
                onClick={handleProcessData}
                disabled={isLoading || processedData.length === 0}
                className="w-full md:w-1/2 inline-flex justify-center items-center gap-2 py-3 px-4 border border-transparent shadow-sm text-lg font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                {isLoading ? 'Processing...' : `Process ${processedData.length} Records`}
              </button>
            </div>

            <div className="bg-gray-50 p-6 rounded-lg border border-gray-200 min-h-[200px] flex flex-col justify-center">
                 <h2 className="text-2xl font-semibold text-gray-800 mb-4 text-center">2. Validation Results</h2>
                 {isLoading && (
                    <Spinner text={`Processing row ${progress.current} of ${progress.total}...`} subtext="This may take a few moments per record."/>
                 )}
                 {!isLoading && error && (
                    <div className="text-center text-red-600 bg-red-50 p-4 rounded-md">
                        <h3 className="font-bold">Error</h3>
                        <p>{error}</p>
                    </div>
                )}
                {!isLoading && !error && results.length === 0 && (
                  <div className="text-center text-gray-500">
                    <p>Validation results will appear here after processing.</p>
                  </div>
                )}
                {results.length > 0 && (
                    <div className="space-y-6">
                        {!isLoading && (
                             <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                                <p className="text-blue-800 font-semibold">Processing complete! {results.length} records validated.</p>
                                <p className="text-sm text-blue-700 mt-1">
                                  You have two options: copy a summary to paste into Google Sheets, or download a full detailed report.
                                </p>
                                <div className="mt-4 flex flex-col sm:flex-row gap-3">
                                  <button
                                      onClick={copyResultsForSheet}
                                      className="inline-flex items-center justify-center gap-2 py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 flex-shrink-0"
                                  >
                                      <ClipboardIcon className="w-5 h-5"/>
                                      {isCopied ? 'Copied to Clipboard!' : 'Copy Update for Google Sheet'}
                                  </button>
                                  <button
                                      onClick={downloadResults}
                                      className="inline-flex items-center justify-center gap-2 py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 flex-shrink-0"
                                  >
                                      <DownloadIcon className="w-5 h-5"/>
                                      Download Full Report (.xlsx)
                                  </button>
                                </div>
                            </div>
                        )}
                        {chartData.length > 0 && !isLoading && <PieChart data={chartData} />}
                        <ResultsTable results={results} />
                    </div>
                )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
};

export default App;