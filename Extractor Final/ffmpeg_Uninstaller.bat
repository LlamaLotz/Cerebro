@echo off
setlocal enabledelayedexpansion

echo ====================================================
echo FFMPEG UNINSTALLER - WINDOWS
echo ====================================================

where ffmpeg >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] FFmpeg is not detected on your current PATH.
)

set /p CONFIRM="Are you sure you want to completely uninstall FFmpeg? (Y/N): "
if /i "%CONFIRM%"=="Y" (
    echo.
    echo 1. Removing FFmpeg via Winget (By Package Name)...
    winget uninstall "FFmpeg (Essentials Build)" -e --accept-source-agreements 2>nul
    winget uninstall FFmpeg -e --accept-source-agreements 2>nul
    winget uninstall Gyan.FFmpeg -e --accept-source-agreements 2>nul

    echo.
    echo 2. Cleaning up WinGet symlinks...
    if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe" (
        del /f /q "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe" 2>nul
    )
    if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffplay.exe" (
        del /f /q "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffplay.exe" 2>nul
    )
    if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffprobe.exe" (
        del /f /q "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffprobe.exe" 2>nul
    )

    echo.
    echo 3. Checking for manual System32 installations...
    if exist "C:\Windows\System32\ffmpeg.exe" (
        echo Attempting to remove ffmpeg binaries from System32...
        del /f /q "C:\Windows\System32\ffmpeg.exe" 2>nul
        del /f /q "C:\Windows\System32\ffplay.exe" 2>nul
        del /f /q "C:\Windows\System32\ffprobe.exe" 2>nul
    )

    echo.
    echo [SUCCESS] FFmpeg uninstallation complete!
) else (
    echo [INFO] Uninstallation cancelled.
)

echo ====================================================
pause