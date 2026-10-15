FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY Notes.Api/Notes.Api.csproj Notes.Api/
RUN dotnet restore Notes.Api/Notes.Api.csproj
COPY Notes.Api/ Notes.Api/
RUN dotnet publish Notes.Api/Notes.Api.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app .
ENV ASPNETCORE_URLS=http://+:8080 DOTNET_CLI_TELEMETRY_OPTOUT=1
USER app
EXPOSE 8080
ENTRYPOINT ["dotnet", "Notes.Api.dll"]
