@echo off
if /I "%MAESTRO_TOOLBOX_ACTION%"=="describe" (
  echo {"name":"review-summary","description":"Prints the required PR review output sections for Maestro first-party review skills.","inputs":["pr","repo","risk_level"],"outputs":["findings","open_questions","verification"]}
  exit /b 0
)

echo Findings:
echo - [severity] file:line - impact and concrete fix direction
echo.
echo Open questions:
echo - None.
echo.
echo Verification:
echo - State the exact checks inspected or run.
