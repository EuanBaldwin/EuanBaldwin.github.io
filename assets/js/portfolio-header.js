(function() {
  var headerContainer = document.getElementById('shared-portfolio-header');
  var footerContainer = document.getElementById('shared-portfolio-footer');

  if (headerContainer) {
    headerContainer.innerHTML = [
      '<div id="header">',
      '  <div class="top">',
      '    <a href="../index.html#top" id="logo-link">',
      '      <div id="logo">',
      '        <span class="image avatar48">',
      '          <img src="../images/profile.jpeg" alt="Euan Baldwin" />',
      '        </span>',
      '        <h1 id="title">Euan Baldwin</h1>',
      '        <p>Robotics MSc</p>',
      '      </div>',
      '    </a>',
      '    <nav id="nav">',
      '      <ul>',
      '        <li><a href="../index.html#top" id="top-link"><span class="icon solid fa-home">Intro</span></a></li>',
      '        <li><a href="../index.html#about" id="about-link"><span class="icon solid fa-user">About Me</span></a></li>',
      '        <li><a href="../index.html#skills" id="skills-link"><span class="icon solid fa-award">Skills</span></a></li>',
      '        <li><a href="../index.html#portfolio" id="portfolio-link"><span class="icon solid fa-th">Portfolio</span></a></li>',
      '      </ul>',
      '    </nav>',
      '  </div>',
      '  <div class="bottom">',
      '    <ul class="icons">',
      '      <li><a href="../CV - 23.10.24.pdf" class="icon solid fa-file"><span class="label">Curriculum Vitae</span></a></li>',
      '      <li><a href="https://www.linkedin.com/in/euan-baldwin-643416231/" class="icon brands fa-linkedin"><span class="label">LinkedIn</span></a></li>',
      '      <li><a href="https://github.com/EuanBaldwin" class="icon brands fa-github"><span class="label">GitHub</span></a></li>',
      '      <li><a href="mailto:euanebaldwin@gmail.com" class="icon solid fa-envelope"><span class="label">Email</span></a></li>',
      '    </ul>',
      '  </div>',
      '</div>'
    ].join('');
  }

  if (footerContainer) {
    footerContainer.innerHTML = [
      '<div id="footer">',
      '  <ul class="copyright">',
      '    <li>&copy; Euan Baldwin 2024. All rights reserved.</li>',
      '    <li>Design: <a href="https://html5up.net">HTML5 UP</a></li>',
      '  </ul>',
      '</div>'
    ].join('');
  }

  if (
    document.querySelector('iframe[src*="player.vimeo.com"]') &&
    !document.querySelector('script[src*="player.vimeo.com/api/player.js"]')
  ) {
    var vimeoScript = document.createElement('script');
    vimeoScript.src = 'https://player.vimeo.com/api/player.js';
    vimeoScript.defer = true;
    document.body.appendChild(vimeoScript);
  }
})();
