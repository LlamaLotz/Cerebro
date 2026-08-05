@echo off
setlocal enabledelayedexpansion

echo ====================================================
echo FORCE PURGING FFMPEG FROM WINDOWS
echo ====================================================

echo 1. Attempting Winget Purge...
winget uninstall --id Gyan.FFmpeg.Essentials -e --purge --accept-source-agreements 2>nul
winget uninstall --id Gyan.FFmpeg -e --purge --accept-source-agreements 2>nul
winget uninstall "FFmpeg (Essentials Build)" -e --purge --accept-source-agreements 2>nul

echo.
echo 2. Deleting WinGet Portable Package Directories...
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Packages" (
    for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*") do (
        echo Removing folder: %%D
        rmdir /s /q "%%D" 2>nul
    )
)

echo.
echo 3. Deleting WinGet Symlinks...
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
echo 4. Cleaning System32 fallback copies (if present)...
if exist "C:\Windows\System32\ffmpeg.exe" del /f /q "C:\Windows\System32\ffmpeg.exe" 2>nul
if exist "C:\Windows\System32\ffplay.exe" del /f /q "C:\Windows\System32\ffplay.exe" 2>nul
if exist "C:\Windows\System32\ffprobe.exe" del /f /q "C:\Windows\System32\ffprobe.exe" 2>nul

echo.
echo ====================================================
echo Purge complete! Testing environment...
echo ====================================================

where ffmpeg >nul 2>nul
if %errorlevel% neq 0 (
    echo [SUCCESS] FFmpeg has been completely removed from PATH!
) else (
    echo [NOTICE] FFmpeg is still responding on PATH. Close all command windows and open a new one to verify.
)

pause