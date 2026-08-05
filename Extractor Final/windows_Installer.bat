@echo off
setlocal enabledelayedexpansion

echo ====================================================
echo Checking Python Version...
echo ====================================================

set "PYTHON_INSTALLED=0"

where python >nul 2>nul
if %errorlevel% equ 0 (
    for /f "tokens=2" %%v in ('python --version 2^>^&1') do set "PY_VER=%%v"
    echo Detected Python version: !PY_VER!
    
    echo !PY_VER! | findstr /R "^3\.14" >nul
    if !errorlevel! equ 0 (
        echo Latest supported Python version ^(!PY_VER!^) is already installed. Skipping Python setup.
        set "PYTHON_INSTALLED=1"
        set "PYCMD=python"
    )
)

if !PYTHON_INSTALLED! equ 0 (
    echo Installing or upgrading to official Python 3.14 release...
    winget install --id Python.Python.3.14 -e --accept-source-agreements --accept-package-agreements
    
    set "PATH=%LOCALAPPDATA%\Programs\Python\Python314;%LOCALAPPDATA%\Programs\Python\Python314\Scripts;%PATH%"
    set "PYCMD=python"
)

echo.
echo ====================================================
echo Installing System Dependencies (FFmpeg Essentials)...
echo ====================================================

winget install "FFmpeg (Essentials Build)" -e --accept-source-agreements --accept-package-agreements

echo.
echo ====================================================
echo Refreshing Environment PATH...
echo ====================================================

:: Read machine and user PATH directly from Registry into active batch session
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH 2^>nul') do set "SYS_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set "USER_PATH=%%B"

set "PATH=%SYS_PATH%;%USER_PATH%;%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"

:: Additional search inside Gyan FFmpeg package directory
for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*") do (
    for /r "%%D" %%F in (ffmpeg.exe) do (
        set "PATH=%%~dpF;!PATH!"
    )
)

where ffmpeg >nul 2>nul
if %errorlevel% equ 0 (
    echo [SUCCESS] FFmpeg bound successfully to current session!
) else (
    echo [NOTICE] FFmpeg is installed. If execution fails, open a new Command Prompt window.
)

echo.
echo ====================================================
echo Installing / Upgrading Python Packages...
echo ====================================================

%PYCMD% -m pip install --upgrade pip
%PYCMD% -m pip install --upgrade yt-dlp faster-whisper torch crawl4ai docling tqdm

echo.
echo ====================================================
echo Setting up Playwright Headless Browsers...
echo ====================================================

%PYCMD% -m playwright install chromium

echo.
echo ====================================================
echo Windows setup complete! Run: %PYCMD% master_extractor.py
echo ====================================================
pause