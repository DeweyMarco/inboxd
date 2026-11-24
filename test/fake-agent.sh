#!/bin/sh
# Stand-in agent for tests: echoes the subject and keeps a session id per thread.
subject=$(grep '^Subject:' | head -1)
echo "fake agent handled -> $subject (session in: ${INBOXD_SESSION:-none})"
echo "INBOXD_SESSION=${INBOXD_SESSION:-sess-$$}"
