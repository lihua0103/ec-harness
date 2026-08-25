@echo off
REM DSH Guard ???? (Windows)
echo Starting DSH Guard...
node node_modules/@deepseek-ai/dsh/lib/bin.js web --config configs/cordis.yml
