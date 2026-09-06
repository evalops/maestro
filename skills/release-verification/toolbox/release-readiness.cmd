@echo off
if /I "%MAESTRO_TOOLBOX_ACTION%"=="describe" (
  echo {"name":"release-readiness","description":"Prints the required release verification report skeleton.","inputs":["repo","revision","environment"],"outputs":["decision","evidence","blockers","next_action"]}
  exit /b 0
)

echo Decision:
echo Evidence:
echo Unavailable sources:
echo Blockers:
echo Next action:
echo Withheld or out of scope:
