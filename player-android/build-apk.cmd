@echo off
rem Builds the Signage Player APK and copies it into the portal's download folder.
rem Uses the portable Java + Android SDK in C:\Users\servi\android-build (nothing is installed system-wide).
setlocal
set "TOOLS=C:\Users\servi\android-build"
set "JAVA_HOME=%TOOLS%\jdk-17.0.21.1+2"
set "ANDROID_HOME=%TOOLS%\sdk"
set "PATH=%JAVA_HOME%\bin;%PATH%"
cd /d "%~dp0"

if not exist "%ANDROID_HOME%\platforms\android-35" (
  echo.
  echo === Step 1: Google's Android SDK license ===
  echo Read each license and type y to accept.
  echo.
  call "%ANDROID_HOME%\cmdline-tools\latest\bin\sdkmanager.bat" --licenses
  echo.
  echo === Step 2: Installing Android SDK platform 35 and build tools ===
  call "%ANDROID_HOME%\cmdline-tools\latest\bin\sdkmanager.bat" "platforms;android-35" "build-tools;35.0.0" "platform-tools"
)

echo.
echo === Building the player app ===
rem Optional: pass your portal address so TVs skip the setup screen, e.g.
rem   build-apk.cmd http://192.168.1.81:3100
set "EXTRA="
if not "%~1"=="" set "EXTRA=-PsignageServerUrl=%~1"
call gradlew.bat --no-daemon testReleaseUnitTest assembleRelease %EXTRA%
if errorlevel 1 (
  echo.
  echo BUILD FAILED - see the messages above.
  pause
  exit /b 1
)

copy /y "app\build\outputs\apk\release\signage-player-1.1.0-release.apk" "..\portal\data\apk\" >nul
echo.
echo Done: app\build\outputs\apk\release\signage-player-1.1.0-release.apk
echo It is also in the portal's download folder (Settings - Download player app).
pause
