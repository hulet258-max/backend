# Admin security configuration

Admin API routes and the `/admin` Socket.IO namespace require a server-issued bearer session.

Set `ADMIN_USERNAME` and either `ADMIN_PASSWORD_HASH` (preferred) or `ADMIN_PASSWORD` in the backend environment. There is no built-in production or development password.

Generate a scrypt hash without putting the password in source control:

```powershell
$env:ADMIN_PASSWORD='replace-this-temporarily'
node -e "const c=require('crypto');const s=c.randomBytes(16);const h=c.scryptSync(process.env.ADMIN_PASSWORD,s,64);console.log('scrypt$'+s.toString('hex')+'$'+h.toString('hex'))"
Remove-Item Env:ADMIN_PASSWORD
```

Copy the printed value into `ADMIN_PASSWORD_HASH`. Admin sessions expire after 12 hours by default; override this with `ADMIN_SESSION_TTL_MS` if needed.
