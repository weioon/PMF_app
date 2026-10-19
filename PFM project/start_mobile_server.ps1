$port = 8080
$folder = Join-Path $PSScriptRoot "src\pfm-client\src"

$listener = New-Object System.Net.HttpListener
$prefix = "http://+:$port/"
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
    Write-Host "Server started on port $port (Serving $folder)"
} catch {
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$port/")
    $listener.Prefixes.Add("http://127.0.0.1:$port/")
    $listener.Start()
    Write-Host "Server started on localhost:$port (Serving $folder)"
}

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $path = $request.Url.LocalPath
        if ($path -eq "/" -or $path -eq "") { $path = "/index.html" }

        $localFile = Join-Path $folder ($path.TrimStart('/').Replace('/', '\'))

        if (Test-Path $localFile -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($localFile)
            $ext = [System.IO.Path]::GetExtension($localFile).ToLower()

            $contentType = "text/plain"
            if ($ext -eq ".html") { $contentType = "text/html; charset=utf-8" }
            elseif ($ext -eq ".json") { $contentType = "application/json; charset=utf-8" }
            elseif ($ext -eq ".js") { $contentType = "application/javascript; charset=utf-8" }
            elseif ($ext -eq ".css") { $contentType = "text/css; charset=utf-8" }
            elseif ($ext -eq ".svg") { $contentType = "image/svg+xml" }

            $response.ContentType = $contentType
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $response.StatusCode = 404
        }
        $response.OutputStream.Close()
    } catch {
        # ignore client disconnects
    }
}
