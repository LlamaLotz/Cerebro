@echo off
setlocal enabledelayedexpansion

echo ====================================================
echo CEREBRO UNINSTALLER - WINDOWS
echo ====================================================

where python >nul 2>nul
if %errorlevel% equ 0 (
    set "PYCMD=python"
) else (
    where py >nul 2>nul
    if %errorlevel% equ 0 (
        set "PYCMD=py"
    ) else (
        echo [INFO] Python command not found in PATH. Skipping Python package removal.
        goto UNINSTALL_SYSTEM
    )
)

echo.
echo ====================================================
echo Removing Playwright Headless Browsers...
echo ====================================================
%PYCMD% -m playwright uninstall --all 2>nul

echo.
echo ====================================================
echo Uninstalling Python Packages...
echo ====================================================
%PYCMD% -m pip uninstall -y yt-dlp faster-whisper torch crawl4ai docling tqdm playwright

:UNINSTALL_SYSTEM
echo.
echo ====================================================
echo System Package Cleanup
echo ====================================================

set /p REMOVE_FFMPEG="Do you want to uninstall FFmpeg via Winget? (Y/N): "
if /i "%REMOVE_FFMPEG%"=="Y" (
    echo Uninstalling FFmpeg...
    winget uninstall --id gyan.ffmpeg -e --accept-source-agreements
)

set /p REMOVE_PYTHON="Do you want to uninstall Python 3.14 via Winget? (Y/N): "
if /i "%REMOVE_PYTHON%"=="Y" (
    echo Uninstalling Python 3.14...
    winget uninstall --id Python.Python.3.14 -e --accept-source-agreements
)

echo.
echo ====================================================
echo Uninstallation complete!
echo ====================================================
pause