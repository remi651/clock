global clockPID, clockResources

on run
  set clockResources to (POSIX path of (path to me)) & "Contents/Resources/"
  set clockPID to do shell script "/bin/bash " & quoted form of (clockResources & "start.sh")
end run

on reopen
  do shell script "/usr/bin/open http://127.0.0.1:34157/"
end reopen

on idle
  return 30
end idle

on quit
  try
    do shell script "/bin/bash " & quoted form of (clockResources & "stop.sh") & " " & quoted form of clockPID
  end try
  continue quit
end quit
