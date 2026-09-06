@echo off
if /I "%MAESTRO_TOOLBOX_ACTION%"=="describe" (
  echo {"name":"incident-timeline","description":"Prints the required incident triage timeline and mitigation sections.","inputs":["incident","start_time","surface"],"outputs":["timeline","blast_radius","mitigation","next_action"]}
  exit /b 0
)

echo Current state:
echo Blast radius:
echo Timeline:
echo - Known:
echo - Inferred:
echo - Unknown:
echo Mitigation:
echo Verification:
echo Next action:
echo Withheld or unavailable evidence:
