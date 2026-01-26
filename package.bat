@echo off
call electron-packager . WalkingJourney --platform=win32 --arch=x64 --overwrite --ignore="^/\.vscode($|/)" --ignore="^/\.gitignore$" --ignore="^/package-bat\.bat$" --ignore="^/README\.md$" --ignore="^/package\.bat$"
echo "打包完成"
del "WalkingJourney-win32-x64\LICENSE"
echo "删除 LICENSE 文件完成"
del "WalkingJourney-win32-x64\LICENSES.chromium.html"
echo "删除 LICENSES.chromium.html 文件完成"
del "WalkingJourney-win32-x64\version"
echo "删除 version 文件完成"
for %%f in (WalkingJourney-win32-x64\locales\*.pak) do (
    if /I not "%%~nxf"=="zh-CN.pak" if /I not "%%~nxf"=="en-US.pak" (
        del "WalkingJourney-win32-x64\locales\%%~nxf"
        echo 删除 %%~nxf 文件完成
    )
)
copy "assets\models\PCBmodel.obj" "WalkingJourney-win32-x64\resources\app\assets\models\PCBmodel.obj"
echo "移动 PCBmodel.obj 文件完成"
for /f "tokens=2 delims=:," %%v in ('findstr /i "\"version\"" package.json') do (
    set "ver=%%~v"
)
set "ver=%ver: =%"
set "ver=%ver:\"=%"
ren "WalkingJourney-win32-x64" "WalkingJourney-v%ver%"
echo "重命名为 WalkingJourney-v%ver% 完成"