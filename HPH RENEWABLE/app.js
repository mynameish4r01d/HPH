const observer = new IntersectionObserver((entries) =>{
    entries.forEach((entry) => {
        console.log(entry)
        if(entry.isIntersecting) {
            entry.target.classList.add('show')
        }else{ entry.target.classList.remove('show');}

    });
});

const hiddenElements = document.querySelectorAll('.hidden');
hiddenElements.forEach((el) => observer.observe(el));


// put this code under the "if" statement if you want animation to loop

//else{ entry.target.classList.remove('show');}




/* Toggle between showing and hiding the navigation menu links when the user clicks on the hamburger menu / bar icon */
function myFunction() {
  var x = document.getElementById("myLinks");
  if (x.style.display === "block") {
    x.style.display = "none";
  } else {
    x.style.display = "block";
  }
}





















//slider - home
let slideIndex = 1;
showSlides(slideIndex);

// Next/previous controls
function plusSlides(n) {
  showSlides(slideIndex += n);
}

// Thumbnail image controls
function currentSlide(n) {
  showSlides(slideIndex = n);
}

function showSlides(n) {
  let i;
  let slides = document.getElementsByClassName("mySlides");
  let dots = document.getElementsByClassName("dot");
  if (n > slides.length) {slideIndex = 1}
  if (n < 1) {slideIndex = slides.length}
  for (i = 0; i < slides.length; i++) {
    slides[i].style.display = "none";
  }
  for (i = 0; i < dots.length; i++) {
    dots[i].className = dots[i].className.replace(" active2", "");
  }
  slides[slideIndex-1].style.display = "block";
  dots[slideIndex-1].className += " active2";
}














document.querySelector(".menu").addEventListener("click", toggleMenu);
document.getElementsByClassName("dropdown")[0].addEventListener("click", toggleMenu);

    let menuLink = document.querySelector(".menu a");
    let dropDown = document.querySelector('ul.dropdown');
    let header = document.querySelector("header");
    let isOpen = 0;

    function toggleMenu() {
        if(isOpen == 0) {
            menuLink.classList.toggle("active");
            header.classList.add("black");
            isOpen++;
        }
        else {
            menuLink.classList.toggle("active");
            header.classList.remove("black");
            isOpen--;
        }
    }
